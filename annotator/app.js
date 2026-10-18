'use strict';
/* ============================ constants ============================ */
const HUMAID = [
  ['caution_and_advice', 'Warnings issued or lifted, guidance and tips related to the disaster.'],
  ['displaced_people_and_evacuations', 'People who have relocated due to the crisis, even for a short time.'],
  ['infrastructure_and_utility_damage', 'Damage to infrastructure such as buildings, houses.'],
  ['injured_or_dead_people', 'Reports of injured or dead people due to the disaster.'],
  ['missing_or_found_people', 'Reports of missing or found people due to the disaster.'],
  ['requests_or_urgent_needs', 'Urgent needs or supplies such as food, water, clothing, money.'],
  ['rescue_volunteering_or_donation_effort', 'Rescue, volunteering, or donation efforts.'],
  ['sympathy_and_support', 'Prayers, thoughts, and emotional support.'],
  ['other_relevant_information', 'On-topic but none of the above.'],
  ['not_humanitarian', 'Does not convey humanitarian aid-related information.'],
  ['irrelevant', "Don't know / can't judge — non-English, insufficient info, or can't determine."],
];
const LABELS = ['op', 'comment', 'target'];
const LS_PROJECTS = 'annotator.projects.v1';
const LS_LABELS = n => 'annotator.labels.v1.' + n;
const LS_POS = n => 'annotator.pos.v1.' + n;
const LS_DATA = n => 'annotator.data.v1.' + n;
const LS_CAPS = n => 'annotator.caps.v1.' + n;
const repository = new AnnotationRepository();
const SKELETON = 'linn_451';




/* ============================ state ============================ */
const state = {
  project: null,   // {name, loader, columns, colIdx, tasks:[{i,...}], rowsAll?, dataDir?, caps?}
  taskIdx: 0,
  labels: {},      // nodeId -> {label, taskId, row:[...], rev?:true}
  mode: 'thread',     // 'thread' | 'point' (point button on/off)
  template: 'full',   // 'full' = label every node | 'relabel' = only the 500-file target per thread
  pointed: '',        // node id Point is currently sitting on (relabel review flow)
};

/* a 500-file target counts as "to do" until it has a label (rev: set on labeling) */
const isReviewed = id => !!(state.labels[id] && state.labels[id].rev);

/* Point again on the same target = accept the current label; just tick it off */
function markReviewed(id) {
  const e = state.labels[id];
  if (!e) return;
  if (e.rev) return;
  e.rev = true;
  saveLabels();
  updateLabeledCount();
  updatePointUI();
}

/* ============================ caps ============================ */
function getCaps(name) {
  return AnnotationScope.normalize(repository.get(LS_CAPS(name), {}));
}
function saveCaps(name, caps) {
  repository.set(LS_CAPS(name), AnnotationScope.normalize(caps));
}
function readCapInputs(ids) {
  const v = id => {
    const input = document.getElementById(id);
    if (!input.reportValidity()) throw new Error('Enter a positive whole number or leave the filter blank.');
    const x = Number(input.value);
    return Number.isSafeInteger(x) && x > 0 ? x : 0;
  };
  return { depth: v(ids[0]), total: v(ids[1]) };
}

/* Relabel focus view: a megathread can have 12k nodes, which makes Point slow and
   the thread unreadable. Keep each target's ANCESTOR CHAIN (so the reply it answers
   is visible) plus a small window of its immediate SIBLINGS — the comments it sits
   among. Capping the sibling window matters: in the r/LosAngeles daily megathreads
   most targets are direct replies to the post, so "all siblings" would mean the
   whole 1,600-comment thread again. */
const SIB_WINDOW = 2;                              // comments kept either side of a target
function focusRows(proj, raw, targetIds) {
  const byId = new Map(raw.map(r => [col(proj, 'node_id', r), r]));
  const parentOf = r => col(proj, 'parent_id', r) || '';
  const kidsOf = new Map();
  for (const r of raw) {
    const p = parentOf(r);
    if (!p) continue;
    if (!kidsOf.has(p)) kidsOf.set(p, []);
    kidsOf.get(p).push(r);
  }
  const cmp = (a, b) => (col(proj, 'created_utc', a) || '').localeCompare(col(proj, 'created_utc', b) || '');
  for (const arr of kidsOf.values()) arr.sort(cmp);

  const keep = new Set();
  for (const t of (targetIds || [])) {
    // 1. the target itself + its whole ancestor chain up to the root
    let cur = byId.get(t), guard = 0;
    while (cur && guard++ < 300) {
      keep.add(cur);
      cur = byId.get(parentOf(cur));
    }
    // 2. a window of siblings around the target — its local conversation only
    const p = byId.has(t) ? parentOf(byId.get(t)) : '';
    const sibs = p ? (kidsOf.get(p) || []) : [];
    const at = sibs.indexOf(byId.get(t));
    if (at >= 0) {
      const from = Math.max(0, at - SIB_WINDOW), to = Math.min(sibs.length, at + SIB_WINDOW + 1);
      for (let i = from; i < to; i++) keep.add(sibs[i]);
    }
  }
  return raw.filter(r => keep.has(r));
}

/* focus is ON for large threads (the megathreads have ~12k nodes, which is what made
   Point unreliable). A "Full thread" toggle in the top bar turns it off per project. */
const FOCUS_THRESHOLD = 400;                        // rows above this get focused
function applyFocus(proj, rows, targetIds) {
  proj.focusTrimmed = 0;
  if (!targetIds?.length) return rows;
  if (proj.focus === 'full') return rows;           // user asked for everything
  if (rows.length <= FOCUS_THRESHOLD) return rows;  // small enough already
  const focused = focusRows(proj, rows, targetIds);
  proj.focusTrimmed = rows.length - focused.length;
  return focused;
}

/* Apply the same strict scope to rendering and Point navigation. */
function applyTrim(proj, raw) {
  const task = proj.tasks[state.taskIdx];
  const allowed = proj.scopeIds?.get(threadKeyOf(task));
  if (allowed) return raw.filter(row => allowed.has(col(proj, 'node_id', row)));
  const group = proj.threadGroup?.get(threadKeyOf(task)) || [task];
  return AnnotationScope.select(raw, (key, row) => col(proj, key, row), proj.caps, Infinity, exemptKeep(proj, group)).rows;
}

/* Relabel-500 only (explicitly created target projects): every target and its
   reply chain ignores the project limits and never spends comment budget.
   Full-pass projects apply both limits to everything. */
function exemptKeep(proj, group) {
  if (state.template !== 'relabel') return null;
  const targets = (group || []).map(task => task.target).filter(Boolean);
  return targets.length ? new Set(targets) : null;
}

/* Allocate an exact total budget once per unique thread, including partial threads. */
async function computeBlocked(proj) {
  proj.scopeIds = new Map();
  proj.usedComments = 0;
  for (const task of proj.tasks) task.blocked = false;
  if (!proj.caps.total) return;
  for (const [key, group] of proj.threadGroup) {
    if (state.project !== proj) return;
    const remaining = proj.caps.total - proj.usedComments;
    const keep = exemptKeep(proj, group);
    if (remaining <= 0 && !keep) { group.forEach(task => task.blocked = true); continue; }
    $('#scope-summary').textContent = `Preparing scope · ${proj.usedComments.toLocaleString()} comments…`;
    const merged = new Map();
    for (const task of group) {
      await ensureTaskRows(task);
      for (const row of task.rawRows) merged.set(col(proj, 'node_id', row), row);
    }
    const selected = AnnotationScope.select([...merged.values()], (k, r) => col(proj, k, r), proj.caps, Math.max(remaining, 0), keep);
    proj.scopeIds.set(key, new Set(selected.rows.map(row => col(proj, 'node_id', row))));
    proj.usedComments += selected.comments;
  }
}

/* ============================ utils ============================ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const autolink = s => esc(s).replace(/(https?:\/\/[^\s<>()]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const fmtBytes = b => b > 1e6 ? (b/1e6).toFixed(1)+' MB' : (b/1e3).toFixed(0)+' KB';

function reportError(error) {
  console.error(error);
  toast(error.message || 'Could not complete this action.', 5000);
}
function setWorkspaceBusy(busy) {
  state.busy = busy;
  $$('#topbar button, #btn-apply-settings, #btn-reset-filters, #thread-queue button, #point-btn').forEach(button => button.disabled = busy);
  if (!busy && state.project) {
    const queue = queueTasks(), current = state.project.tasks[state.taskIdx];
    const index = current ? queue.findIndex(task => threadKeyOf(task) === threadKeyOf(current)) : -1;
    $('#btn-prev').disabled = index <= 0;
    $('#btn-next').disabled = index < 0 || index >= queue.length - 1;
  }
}
function queueTasks() {
  const proj = state.project;
  return [...proj.threadGroup.values()].map(group => group[0]).filter(task => !task.blocked);
}
function renderQueue() {
  if (!state.project) return;
  const proj = state.project, current = proj.tasks[state.taskIdx];
  const query = $('#queue-search').value.trim().toLowerCase();
  const tasks = queueTasks();
  $('#queue-count').textContent = tasks.length;
  const filters = [];
  if (proj.caps.depth) filters.push(`Depth ≤ ${proj.caps.depth}`);
  if (proj.caps.total) filters.push(`${proj.usedComments.toLocaleString()} / ${proj.caps.total.toLocaleString()} comments`);
  $('#scope-summary').textContent = filters.join(' · ') || 'All threads · No limits';
  const matches = tasks.filter(task => `${task.title} ${task.sub} ${task.threadId} ${task.i}`.toLowerCase().includes(query));
  $('#thread-queue').innerHTML = matches.map(task => `<button class="queue-item ${current && threadKeyOf(task) === threadKeyOf(current) ? 'active' : ''}" data-task="${task.i}" ${current && threadKeyOf(task) === threadKeyOf(current) ? 'aria-current="true"' : ''}><small>${task.sub ? 'r/' + esc(task.sub) : 'Reddit'} · #${task.i}</small><strong>${esc(task.title || task.targetText || task.threadId || 'Untitled conversation')}</strong></button>`).join('') || '<p class="hint">No matching threads.</p>';
}
$('#queue-search').addEventListener('input', renderQueue);
$('#thread-queue').addEventListener('click', event => {
  const button = event.target.closest('[data-task]');
  if (!button || state.busy) return;
  state.taskIdx = state.project.tasks.findIndex(task => task.i === +button.dataset.task);
  renderTask().catch(reportError);
});
$('#btn-import').onclick = () => $('#file-input').click();
$('#label-guide').innerHTML = HUMAID.map(([label, description]) => `<details><summary>${esc(label.replaceAll('_', ' '))}</summary><p>${esc(description)}</p></details>`).join('');

// Selected targets are derived from the same scope as the reading pane.
function targetInScope(task) {
  const proj = state.project;
  const allowed = proj.scopeIds?.get(threadKeyOf(task));
  if (allowed) return allowed.has(task.target);
  if (!proj.caps.depth || !task.rawRows) return true;
  const group = proj.threadGroup?.get(threadKeyOf(task)) || [task];
  return AnnotationScope.select(task.rawRows, (k, r) => col(proj, k, r), proj.caps, Infinity, exemptKeep(proj, group))
    .rows.some(row => col(proj, 'node_id', row) === task.target);
}

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function loadProjectList() {
  try { return repository.get(LS_PROJECTS, []); }
  catch { return []; }
}
function saveProjectList(list) {
  repository.set(LS_PROJECTS, list);
}
function loadLabels(name) {
  try { return repository.get(LS_LABELS(name), {}); }
  catch { return {}; }
}
let labelSaveTimer = null;
function saveLabels(immediate) {
  clearTimeout(labelSaveTimer);
  const doSave = () => {
    if (!state.project) return;
    try {
      repository.set(LS_LABELS(state.project.name), state.labels);
      const t = new Date().toTimeString().slice(0, 8);
      $('#st-storage').textContent = 'autosaved ✓ ' + t;
    } catch (e) {
      toast('Storage full — export your labels now!', 4000);
      console.error(e);
    }
  };
  if (immediate) doSave();
  else labelSaveTimer = setTimeout(doSave, 150);
}
window.addEventListener('pagehide', () => {
  if (!state.project) return;
  try { repository.set(LS_LABELS(state.project.name), state.labels); } catch {}
});

function injectScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function download(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ============================ home ============================ */
function renderHome() {
  const host = $('#file-list');
  const created = loadProjectList();
  if (!created.length) {
    host.innerHTML = '<div class="empty"><span class="empty-icon">↗</span><h3>A fresh start for your research.</h3><p>Create a project above or import a thread CSV to begin annotating.</p></div>';
    return;
  }
  let html = '<div class="panel project-table">' +
    '<table class="files"><tr><th>project</th><th>mode</th><th>labeled</th><th>created</th><th></th></tr>';
  for (const p of created) {
    const n = Object.keys(loadLabels(p.name)).length;
    const d = new Date(p.created || 0).toLocaleDateString();
    const relabel = !!p.pre500;
    html += `<tr>
      <td><b>${esc(p.name)}.csv</b><span class="badge">${p.imported ? 'imported' : 'skeleton'}</span></td>
      <td class="hint">${relabel ? 'Relabel 500 · Point' : 'Full pass'}</td>
      <td>${n ? `<b>${n}</b> node${n === 1 ? '' : 's'}` : '<span class="hint">none yet</span>'}</td>
      <td class="hint">${esc(d)}</td>
      <td class="row-actions"><button class="btn ${relabel ? 'orange' : ''}" data-open="${esc(p.name)}">${relabel ? 'Open →' : 'Open →'}</button>
      <button class="btn ghost" data-forget="${esc(p.name)}" title="delete project + its labels">✕</button></td>
    </tr>`;
  }
  html += '</table></div>';
  host.innerHTML = html;

  host.querySelectorAll('[data-open]').forEach(b =>
    b.onclick = () => {
      const entry = loadProjectList().find(p => p.name === b.dataset.open);
      openSavedProject(b.dataset.open, entry?.pre500 ? 'point' : 'thread', entry?.pre500 ? 'relabel' : 'full').catch(reportError);
    });
  host.querySelectorAll('[data-forget]').forEach(b =>
    b.onclick = () => {
      const n = b.dataset.forget;
      if (!confirm(`Delete project "${n}" and its labels from this browser?`)) return;
      saveProjectList(loadProjectList().filter(p => p.name !== n));
      repository.remove(LS_LABELS(n));
      repository.remove(LS_POS(n));
      repository.remove(LS_DATA(n));
      repository.remove(LS_CAPS(n));
      renderHome();
    });
}

$('#newproj-form').addEventListener('submit', async e => {
  e.preventDefault();
  const submitterId = (e.submitter && e.submitter.id) || '';
  const with500 = submitterId === 'btn-create-blank-500';
  const name = $('#newproj-name').value.trim();
  if (!name) { toast('Project name is required'); return; }
  if (name === SKELETON) { toast('That name is reserved for the skeleton'); return; }
  const list = loadProjectList();
  if (list.some(p => p.name === name)) { toast('Project name already exists'); return; }
  const caps = readCapInputs(['cap-depth', 'cap-total']);
  $$('#newproj-form button').forEach(button => button.disabled = true);
  try {
    // instantiate skeleton first — only save if OK
    await openSkeletonProject(name, caps, with500 ? 'point' : 'thread', with500 ? 'relabel' : 'full');
    list.push({ name, skeleton: true, pre500: with500, created: Date.now() });
    saveProjectList(list);
    $('#newproj-name').value = '';
    ['cap-depth', 'cap-total'].forEach(id => document.getElementById(id).value = '');
    window.FilterPreview?.refresh('cap');
    if (with500) {
      updateLabeledCount();
      updatePointUI();
      toast('Clean project — all 500 targets empty. Point walks them one by one.', 4000);
    }
  } catch (err) {
    console.error(err);
    toast('Could not load skeleton data: ' + err.message, 4000);
    backHome();
  } finally {
    $$('#newproj-form button').forEach(button => button.disabled = false);
  }
});

/* open a project saved in this browser */
async function openSavedProject(name, mode, template) {
  const entry = loadProjectList().find(p => p.name === name);
  if (!entry) return toast('Project not found');
  if (entry.imported) {
    let data;
    try { data = repository.get(LS_DATA(name)); } catch {}
    if (!data) return toast('Imported rows missing from browser storage — re-import the CSV');
    const proj = { name, loader: 'inline', columns: data.columns, rowsAll: data.rows };
    buildColIdx(proj);
    groupInlineTasks(proj);
    await startProject(proj, mode, template);
  } else {
    await openSkeletonProject(name, null, mode, template);
  }
}

/* ============================ project loaders ============================ */
async function openSkeletonProject(name, caps, mode, template) {
  if (!window.DATA_CHUNKED?.[SKELETON]) await injectScript(`data_annotated/${SKELETON}/index.js`);
  const meta = window.DATA_CHUNKED[SKELETON];
  const proj = {
    name, loader: 'skeleton', dataDir: SKELETON, columns: meta.columns,
    tasks: meta.tasks.map(t => ({ ...t })),          // per-project copies
    chunked: { chunks: meta.chunks, loaded: new Set() },
    caps: caps || getCaps(name),
  };
  buildColIdx(proj);
  if (caps) saveCaps(name, caps);
  if (template === 'relabel') appendMissingPostTasks(proj);
  await startProject(proj, mode, template);
}

/* the 49 of the original 500 with no recovered thread — standalone posts to label */
function appendMissingPostTasks(proj) {
  const mk = (p, idx) => {
    const i = 451 + idx + 1;
    const nid = 't1_' + p.id;
    const row = proj.columns.map(() => '');
    const set = (k, v) => { const c = proj.colIdx[k]; if (c !== undefined) row[c] = v; };
    set('task_index', i); set('thread_id', 'missing_' + p.id); set('node_id', nid);
    set('parent_id', ''); set('role', 'op'); set('created_utc', '—');
    set('state', 'ok'); set('replies', 0); set('is_target', '1');
    set('text', p.text); set('label', '');
    return {
      i, target: nid, oldLabel: p.label, root: nid, sourceRow: p.row,
      threadId: 'missing_' + p.id, sub: '', title: p.text.split('\n')[0].slice(0, 100),
      nodes: 1, standalone: true, unrecovered: p.id,
      rawRows: [row], byId: new Map([[nid, row]]),
    };
  };
  proj.tasks.push(...MISSING_POSTS.map(mk));
  proj.missingCount = MISSING_POSTS.length;
}

/* ============================ chunked row loading ============================ */
function buildColIdx(proj) {
  proj.colIdx = {};
  proj.columns.forEach((c, i) => proj.colIdx[c] = i);
}
const col = (proj, name, row) => {
  const i = proj.colIdx[name];
  return i === undefined ? '' : (row[i] ?? '');
};

function groupInlineTasks(proj) {
  const groups = new Map();
  for (const row of proj.rowsAll) {
    const k = col(proj, 'task_index', row) || '1';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  proj.tasks = [...groups.entries()].sort((a, b) => (+a[0]) - (+b[0])).map(([k, rows], idx) => {
    const byId = new Map(rows.map(r => [col(proj, 'node_id', r), r]));
    const opRow = rows.find(r => col(proj, 'role', r) === 'op') || rows[0];
    const tRow = rows.find(r => col(proj, 'is_target', r) === '1' || col(proj, 'role', r) === 'target');
    return {
      i: +k || idx + 1, rows, byId,
      title: '',
      target: tRow ? col(proj, 'node_id', tRow) : '',
      root: opRow ? col(proj, 'node_id', opRow) : '',
      created: opRow ? col(proj, 'created_utc', opRow) : '',
      threadId: opRow ? col(proj, 'thread_id', opRow) : '',
    };
  });
}

function attachChunkRows(proj, chunkNo) {
  const meta = window.DATA_CHUNKED[proj.dataDir];
  // new dedupe builds keep descriptors in meta.chunks and rows in meta.rows;
  // legacy builds stored rows in meta.chunks (loading replaced a descriptor)
  const rows = meta.rows ? meta.rows[chunkNo] : meta.chunks[chunkNo];
  if (!Array.isArray(rows)) return false;
  proj.chunked.loaded.add(chunkNo);
  // dedupe builds store each thread's rows once; clone per task and stamp the
  // task-specific columns. Legacy builds stored rows already expanded per task.
  const dedupe = meta.dedupe === true;
  const idx = k => proj.colIdx[k];
  for (const t of proj.tasks) {
    if (t.chunk !== chunkNo || t.rawRows) continue;
    t.rawRows = dedupe
      ? rows.map(r => {
          const row = r.slice();
          row[idx('task_index')] = t.i;
          if (t.target && row[idx('node_id')] === t.target) {
            row[idx('is_target')] = '1';
            row[idx('role')] = 'target';
          } else if (t.root && row[idx('node_id')] === t.root) {
            row[idx('is_target')] = '1';            // legacy builds flag the post row too
          }
          return row;
        })
      : rows.filter(r => +col(proj, 'task_index', r) === t.i);
    t.byId = new Map(t.rawRows.map(r => [col(proj, 'node_id', r), r]));
    for (const r of t.rawRows) {                    // seed any pre-existing CSV labels (from full data)
      const lab = col(proj, 'label', r);
      const id = col(proj, 'node_id', r);
      if (lab && !state.labels[id]) state.labels[id] = { label: lab, taskId: t.i, row: r };
    }
  }
  return true;
}

async function ensureTaskRows(task) {
  const proj = state.project;
  if (proj.dataDir && !task.rawRows) {
    if (!attachChunkRows(proj, task.chunk)) {
      await injectScript(`data_annotated/${proj.dataDir}/c${String(task.chunk).padStart(2, '0')}.js`);
      attachChunkRows(proj, task.chunk);
    }
  }
  if (!task.rawRows) task.rawRows = [];
  if (!task.byId) task.byId = new Map(task.rawRows.map(r => [col(proj, 'node_id', r), r]));
  if (!task._seeded) {
    task._seeded = true;
    for (const r of (task.rawRows || [])) {
      const lab = col(proj, 'label', r);
      const id = col(proj, 'node_id', r);
      if (lab && !state.labels[id]) state.labels[id] = { label: lab, taskId: task.i, row: r };
    }
  }
}

/* ============================ project lifecycle ============================ */
async function startProject(proj, mode, template) {
  saveLabels(true);
  state.project = proj;
  state.mode = mode || 'thread';
  state.template = template || 'full';
  if (!proj.focus) proj.focus = 'auto';             // auto = focus only on huge threads
  state.labels = loadLabels(proj.name);
  if (!proj.caps) proj.caps = getCaps(proj.name);
  // inline/imported projects: rows already in memory — expose rawRows map
  for (const t of proj.tasks) {
    if (!t.rawRows && t.rows) {
      t.rawRows = t.rows;
      t.byId = new Map(t.rawRows.map(r => [col(proj, 'node_id', r), r]));
    }
  }
  // group tasks by thread — Relabel-500 Point walks a thread's targets one by one
  proj.threadGroup = new Map();
  for (const t of proj.tasks) {
    const k = t.threadId || ('i' + t.i);
    if (!proj.threadGroup.has(k)) proj.threadGroup.set(k, []);
    proj.threadGroup.get(k).push(t);
  }
  $('#home').hidden = true;
  $('#workspace').hidden = false;
  $('#statusbar').hidden = false;
  $('#thread').innerHTML = '<div class="card">Preparing project scope…</div>';
  setWorkspaceBusy(true);
  try { await computeBlocked(proj); } finally { setWorkspaceBusy(false); }
  const saved = +repository.get(LS_POS(proj.name), 0);
  state.taskIdx = proj.tasks.findIndex(t => t.i === saved && !t.blocked);
  if (state.taskIdx < 0) state.taskIdx = 0;
  $('#proj-name').innerHTML = state.template === 'relabel'
    ? `${esc(proj.name)}<small>${proj.threadGroup.size} threads · ${proj.tasks.length} annotations · Relabel-500 · Point</small>`
    : `${esc(proj.name)}<small>${proj.threadGroup.size} threads · Full annotation</small>`;
  $('#st-project').textContent = proj.name;
  const pt = state.mode === 'point';
  $('#point-btn').hidden = !pt;
  $('#point-progress').hidden = !pt;
  updateLabeledCount();
  if (!proj.tasks.length) { toast('Project has no rows'); backHome(); return; }
  updateFocusBtn();
  renderQueue();
  await renderTask();
}

function backHome() {
  saveLabels(true);
  ++renderGen;
  $('#workspace').hidden = true;
  $('#statusbar').hidden = true;
  $('#home').hidden = false;
  $('#point-btn').hidden = true;
  $('#point-progress').hidden = true;
  location.hash = '';
  renderHome();
}
window.backHome = backHome;

$('#btn-home').onclick = backHome;

/* import a CSV file as a NEW project (autosaves rows in browser storage) */
$('#file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) { toast('CSV has no data rows'); return; }
  const name = file.name.replace(/\.csv$/i, '');
  const list = loadProjectList();
  if (name === SKELETON || list.some(p => p.name === name)) {
    toast('A project with that name already exists'); return;
  }
  const payload = { columns: rows[0], rows: rows.slice(1) };
  const required = ['task_index', 'node_id', 'parent_id', 'role', 'text'];
  const missing = required.filter(column => !payload.columns.includes(column));
  if (missing.length) { toast('CSV is missing columns: ' + missing.join(', '), 5000); return; }
  let autosaved = true;
  try { repository.set(LS_DATA(name), payload); }
  catch { autosaved = false; }
  list.push({ name, imported: true, created: Date.now() });
  saveProjectList(list);
  const proj = { name, loader: 'inline', columns: payload.columns, rowsAll: payload.rows };
  buildColIdx(proj);
  groupInlineTasks(proj);
  await startProject(proj);
  toast(`Imported ${file.name}: ${proj.tasks.length} tasks` +
        (autosaved ? ' (autosaved in browser)' : ' (too big to autosave rows — labels still autosave)'));
});

/* ============================ task rendering ============================ */
let renderGen = 0;                                  // cancels overlapping async renders
async function renderTask() {
  const proj = state.project;
  const gen = ++renderGen;                          // this render's ticket
  const stale = () => gen !== renderGen;            // a newer render has taken over
  const task = proj.tasks[state.taskIdx];
  if (!task) { toast('No such task'); backHome(); return; }
  repository.set(LS_POS(proj.name), task.i);
  const route = new URLSearchParams({ p: proj.name, t: task.i });
  history.replaceState(null, '', '#' + route.toString());

  const meta_ = task.standalone
    ? `post ${esc(task.unrecovered)} · no thread recovered`
    : `task ${esc(String(task.i))}${task.sub ? ' · r/' + esc(task.sub) : ''}`;
  const queue = queueTasks(), queueIndex = queue.findIndex(t => threadKeyOf(t) === threadKeyOf(task));
  $('#taskpos').innerHTML = `Thread ${queueIndex + 1} / ${queue.length}<small id="task-meta">${meta_}</small>`;
  $('#btn-prev').disabled = queueIndex <= 0;
  $('#btn-next').disabled = queueIndex >= queue.length - 1;
  renderQueue();
  proj.focusTrimmed = 0;
  state.viewById = new Map();
  $('#visible-count').textContent = 'Loading…';

  const host = $('#thread');
  if (task.blocked) {
    const caps = proj.caps || {};
    host.innerHTML = `<div class="card">
      <div class="post-title">⏸ Data cap reached</div>
      <p class="body">This project's comment budget of <b>${(caps.total || 0).toLocaleString()}</b> is used up before task ${esc(String(task.i))}.
      Open <b>Filters</b> to raise or clear the budget.</p>
    </div>`;
    updatePointUI();
    return;
  }
  host.innerHTML = '<div class="card">Loading thread…</div>';

  let viewRows, taskOf, groupTargets, oldByTarget, groupSize;
  state.pointed = '';
  if (state.template === 'relabel') {
    // merged view: ALL 500-file targets of this thread, Point walks them one by one
    const group = proj.threadGroup.get(task.threadId || 'i' + task.i) || [task];
    groupSize = group.length;
    for (const g of group) {
      await ensureTaskRows(g);
      if (stale()) return;                          // user moved on mid-load — bail out
    }
    const merged = new Map();                      // id -> row (prefer role=target copy)
    taskOf = new Map();                            // id -> task.i that owns it
    groupTargets = new Set();
    oldByTarget = new Map();
    for (const g of group) {
      if (g.target) { groupTargets.add(g.target); oldByTarget.set(g.target, g.oldLabel || ''); }
      for (const r of (g.rawRows || [])) {
        const id = col(proj, 'node_id', r);
        if (!id) continue;
        const isT = col(proj, 'is_target', r) === '1' || col(proj, 'role', r) === 'target';
        if (!merged.has(id) || isT) merged.set(id, r);
        if (!taskOf.has(id) || isT) taskOf.set(id, g.i);
      }
    }
    const scoped = applyTrim(proj, [...merged.values()]);
    groupTargets = new Set([...groupTargets].filter(id => scoped.some(row => col(proj, 'node_id', row) === id)));
    viewRows = applyFocus(proj, scoped, [...groupTargets]);
    if (groupSize > 1) $('#task-meta').textContent += ` · ${groupSize} labels in this thread`;
  } else {
    await ensureTaskRows(task);
    if (stale()) return;
    viewRows = applyTrim(proj, task.rawRows);
    taskOf = groupTargets = oldByTarget = null;
    groupSize = 1;
  }
  if (stale()) return;

  const byId = new Map(viewRows.map(r => [col(proj, 'node_id', r), r]));
  state.viewById = byId;                           // for Point jumps (parent walk)
  const visibleComments = viewRows.filter(row => col(proj, 'role', row) !== 'op').length;
  $('#visible-count').textContent = `${visibleComments.toLocaleString()} comments in view`;
  const roots = [];
  const childrenOf = new Map();
  for (const r of viewRows) {
    const id = col(proj, 'node_id', r);
    if (!id) continue;
    const pid = col(proj, 'parent_id', r);
    if (!pid || !byId.has(pid)) roots.push(r);
    else {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(r);
    }
  }
  if (!roots.length) { host.innerHTML = '<div class="card">No rows for this task.</div>'; updatePointUI(); return; }

  host.innerHTML = '';
  if (proj.caps.depth || proj.caps.total) host.insertAdjacentHTML('beforeend', state.template === 'relabel'
    ? '<div class="scope-notice">Filters trim surrounding context only — every 500-target and its reply chain stays in view. Saved labels remain available for export.</div>'
    : '<div class="scope-notice">Project filters are active. Only rows within your limits appear here; saved labels remain available for export.</div>');
  if (task.note) {
    const note = state.template === 'full' ? task.note.replace(/Label only the highlighted target\./gi, '') : task.note;
    host.insertAdjacentHTML('beforeend', `<div class="note">${esc(note)}</div>`);
  }
  if (proj.focusTrimmed > 0) {
    host.insertAdjacentHTML('beforeend',
      `<div class="note">🔎 Focused view — showing each target's reply chain and its siblings. ` +
      `${proj.focusTrimmed.toLocaleString()} other comments hidden. ` +
      `<button class="linkbtn" id="focus-hint">Show full thread</button></div>`);
  }
  const frag = document.createDocumentFragment();
  const opts = { task, groupTargets, taskOf, oldByTarget, rowCount: viewRows.length, solo: !!task.standalone, focused: proj.focusTrimmed > 0 };
  for (const r of roots) frag.appendChild(renderNode(r, 0, childrenOf, { ...opts, isPost: col(proj, 'role', r) === 'op' }));
  host.appendChild(frag);

  // auto-scroll + flash the first target still to review (relabel) or the target (full)
  const flashId = (groupTargets && [...groupTargets].find(id => !isReviewed(id))) || task.target;
  const targetEl = flashId && host.querySelector(`.c.target[data-id="${CSS.escape(flashId)}"]`);
  if (targetEl) {
    setTimeout(() => {
      targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      targetEl.style.transition = 'background 1s';
      const card = targetEl.querySelector('.card');
      if (card) {
        card.style.boxShadow = '0 0 0 3px rgba(255,69,0,.45)';
        setTimeout(() => card.style.boxShadow = '', 1800);
      }
    }, 120);
  }
  updateLabeledCount();
  updatePointUI();
}

function labelSelectHTML(nodeId, taskId) {
  const cur = state.labels[nodeId]?.label || '';
  let opts = `<option value="">— unlabeled —</option>`;
  for (const [v, hint] of HUMAID) {
    opts += `<option value="${v}" title="${esc(hint)}" ${v === cur ? 'selected' : ''}>${esc(v.replaceAll('_', ' '))}</option>`;
  }
  return `<div class="labelctl" data-node="${esc(nodeId)}" data-task="${esc(taskId)}">
    <select class="label-select" aria-label="Label for ${esc(nodeId)}" title="HumAID category for this node">${opts}</select>
    <button class="clearbtn" title="Clear label">Clear</button>
    <span class="chip ${cur ? 'set' : ''}">${cur ? esc(cur.replaceAll('_', ' ')) : ''}</span>
  </div>`;
}

function renderNode(row, depth, childrenOf, opts) {
  const proj = state.project;
  const task = opts.task;
  const id = col(proj, 'node_id', row);
  const role = col(proj, 'role', row) || 'comment';
  const state_ = col(proj, 'state', row) || 'ok';
  const created = col(proj, 'created_utc', row);
  const replies = col(proj, 'replies', row);
  const text = col(proj, 'text', row);
  const isTarget = opts.groupTargets
    ? opts.groupTargets.has(id)
    : (col(proj, 'is_target', row) === '1' || role === 'target');
  const oldLabel = opts.oldByTarget ? opts.oldByTarget.get(id) : (isTarget ? task.oldLabel : '');
  const taskId = opts.taskOf ? opts.taskOf.get(id) : task.i;
  const kidOpts = { task, groupTargets: opts.groupTargets, taskOf: opts.taskOf, oldByTarget: opts.oldByTarget, rowCount: opts.rowCount, focused: opts.focused };

  const wrap = document.createElement('div');
  wrap.className = 'c' + (isTarget ? ' target' : '');
  wrap.dataset.id = id;
  // labelable = full pass (everything) | relabel (the 500-file comments/posts only)
  const labelable = state.template === 'full' || isTarget;

  if (opts.isPost) {
    const solo = !!opts.solo;                      // an original post with no recovered thread
    const where = solo ? '' : `r/${esc(task.sub || '')} · `;
    wrap.innerHTML = `<div class="card">
      <div class="c-meta">${where}${esc(created)}
        ${state_ !== 'ok' ? `<span class="state">— ${esc(state_)} text</span>` : ''}
        ${solo ? '<span class="badge">post — no thread recovered</span>' : ''}</div>
      <div class="post-title">${autolink(task.title || text.split('\n')[0])}</div>
      <div class="body">${autolink(text)}</div>
      ${labelable ? labelSelectHTML(id, taskId) : ''}
      <div class="c-children"></div>
    </div>`;
  } else {
    // relabel: only the 500-file target comments are labelable — everything else is context
    wrap.innerHTML = `<div class="card">
      <div class="c-meta">
        <button class="collapsebtn" title="collapse">[–]</button>
        ${esc(created)} · ${esc(replies)} replies
        ${state_ !== 'ok' ? `<span class="state">— ${esc(state_)} text</span>` : ''}
      </div>
      ${text ? `<div class="body">${autolink(text)}</div>` : '<div class="body deleted">no text recovered</div>'}
      ${labelable ? labelSelectHTML(id, taskId) : ''}
      <div class="c-children"></div>
    </div>`;
  }

  const childHost = wrap.querySelector('.c-children');
  const kids = (childrenOf.get(id) || []).slice()
    .sort((a, b) => (col(proj, 'created_utc', a) || '').localeCompare(col(proj, 'created_utc', b) || ''));
  if (kids.length) {
    // Focus mode already bounded the row count to the target's local conversation,
    // so don't bury that context behind an expand button — only depth collapses.
    const focusOn = !!opts.focused;
    const forceCollapse = depth >= 8 || (!focusOn && kids.length > 25) || opts.rowCount > 3000 && depth >= 3;
    if (forceCollapse) {
      const btn = document.createElement('button');
      btn.className = 'expandbtn';
      btn.dataset.expandFor = id;
      btn.textContent = `▶ show ${kids.length} ${kids.length === 1 ? 'reply' : 'replies'}`;
      btn.onclick = () => {
        btn.replaceWith(...kids.map(k => renderNode(k, depth + 1, childrenOf, kidOpts)));
      };
      childHost.appendChild(btn);
    } else {
      for (const k of kids) childHost.appendChild(renderNode(k, depth + 1, childrenOf, kidOpts));
    }
  }

  const cb = wrap.querySelector('.collapsebtn');
  if (cb) {
    cb.onclick = () => {
      const open = childHost.hasAttribute('hidden') || (!childHost.hidden && cb.textContent === '[–]');
      if (cb.textContent === '[–]') {
        childHost.hidden = true;
        childHost.style.display = 'none';
        cb.textContent = '[+]';
      } else {
        childHost.hidden = false;
        childHost.style.display = '';
        cb.textContent = '[–]';
      }
    };
  }
  return wrap;
}

/* label change / clear (delegated) */
$('#thread').addEventListener('change', e => {
  const sel = e.target.closest('.label-select');
  if (!sel) return;
  const ctl = sel.closest('.labelctl');
  setLabel(ctl.dataset.node, +ctl.dataset.task, sel.value);
});
$('#thread').addEventListener('click', e => {
  const btn = e.target.closest('.clearbtn');
  if (!btn) return;
  const ctl = btn.closest('.labelctl');
  setLabel(ctl.dataset.node, +ctl.dataset.task, '');
  ctl.querySelector('.label-select').value = '';
});

function setLabel(nodeId, taskId, label) {
  const proj = state.project;
  const task = proj.tasks.find(t => t.i === taskId);
  const row = task?.byId?.get(nodeId) || task?.rawRows?.find(r => col(proj, 'node_id', r) === nodeId);
  if (label) {
    state.labels[nodeId] = { label, taskId, row: row ? row.slice() : null, rev: true };
  } else {
    delete state.labels[nodeId];
  }
  const ctl = $(`.labelctl[data-node="${CSS.escape(nodeId)}"]`);
  if (ctl) {
    const chip = ctl.querySelector('.chip');
    chip.textContent = label.replaceAll('_', ' ');
    chip.classList.toggle('set', !!label);
  }
  saveLabels();
  updateLabeledCount();
  updatePointUI();
}

/* ============================ Point mode (Relabel-500 template only) ============================ */
/* relabel: needed = every 500-file target of the current thread, walked one by one */
function relabelGroupOf(task) {
  const proj = state.project;
  return proj.threadGroup?.get(task.threadId || 'i' + task.i) || [task];
}

function unlabeledCount() {
  const proj = state.project, task = proj.tasks[state.taskIdx];
  if (!task || task.blocked) return 0;
  if (state.template === 'relabel') {
    return relabelGroupOf(task).reduce((n, g) => n + (g.target && state.viewById?.has(g.target) && !isReviewed(g.target) ? 1 : 0), 0);
  }
  if (!task.rawRows) return 0;
  let n = 0;
  for (const r of state.viewById?.values() || []) {
    if (!state.labels[col(proj, 'node_id', r)]) n++;
  }
  return n;
}

function updatePointUI() {
  if (state.mode !== 'point' || !state.project) return;
  const btn = $('#point-btn'), prog = $('#point-progress');
  const task = state.project.tasks[state.taskIdx];
  if (!task || task.blocked) {
    btn.classList.add('done');
    btn.textContent = 'Next ▶';
    btn.title = 'Data-capped task — go to next thread';
    prog.textContent = 'capped';
    return;
  }
  const left = unlabeledCount();
  if (left === 0) {
    btn.classList.add('done');
    btn.textContent = 'Next ▶';
    btn.title = 'All targets in this thread reviewed — go to next thread';
    prog.textContent = '✓ done';
  } else {
    btn.classList.remove('done');
    btn.textContent = 'Point';
    btn.title = 'Jump to the next target to review — click again to accept its label';
    prog.textContent = left === 1 ? '1 left' : `${left} left`;
  }
}

/* expand collapsed ancestors, scroll to node, highlight + focus its select */
function jumpToNode(id) {
  const proj = state.project;
  const view = state.viewById || new Map();
  // path root -> target (rows exist even when not rendered yet)
  const path = [];
  let cur = id, guard = 0;
  while (cur && guard++ < 300) {
    path.unshift(cur);
    const row = view.get(cur);
    if (!row) break;
    cur = col(proj, 'parent_id', row);
  }
  // expand TOP-DOWN along the path: a collapse button only exists once its
  // ancestors are rendered, so visiting parents before children works in one pass
  for (const pid of path) {
    const node = document.querySelector(`.c[data-id="${CSS.escape(pid)}"]`);
    if (node) {
      const cb = node.querySelector('.collapsebtn');        // user-collapsed?
      if (cb && cb.textContent === '[+]') cb.click();
    }
    const exp = document.querySelector(`.expandbtn[data-expand-for="${CSS.escape(pid)}"]`);
    if (exp) exp.click();                                   // force-collapsed?
  }
  const el = document.querySelector(`.c[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  $$('.c.pointed').forEach(x => x.classList.remove('pointed'));
  el.classList.add('pointed');
  state.pointed = id;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const sel = el.querySelector('.label-select');
  if (sel) setTimeout(() => sel.focus(), 350);
}

function pointJump() {
  const proj = state.project, task = proj.tasks[state.taskIdx];
  if (!task || task.blocked) return;
  if (state.template === 'relabel') {
    const group = relabelGroupOf(task);
    // Point always lands on the FIRST unlabeled 500-comment of this thread
    // (first-come order) and KEEPS pointing at it until the user labels it —
    // only a real label moves it on; when none remain the button is "Next".
    const next = group.find(g => g.target && state.viewById?.has(g.target) && !isReviewed(g.target));
    if (next) jumpToNode(next.target);
    else state.pointed = '';
    updatePointUI();
    return;
  }
  if (!task.rawRows) return;
  const next = [...(state.viewById?.values() || [])].find(r => !state.labels[col(proj, 'node_id', r)]);
  if (!next) { updatePointUI(); return; }
  jumpToNode(col(proj, 'node_id', next));
}

function pointAdvance() {
  const proj = state.project;
  // forward to the next thread whose 500-file targets are not all labeled
  const seen = new Set();
  for (let i = state.taskIdx + 1; i < proj.tasks.length; i++) {
    const t = proj.tasks[i];
    const key = t.threadId || ('i' + t.i);
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.blocked) continue;
    const group = proj.threadGroup.get(key) || [t];
    const pending = group.find(g => g.target && targetInScope(g) && !isReviewed(g.target));
    if (pending) { state.taskIdx = proj.tasks.indexOf(pending); renderTask().catch(reportError); return; }
  }
  toast('No pending targets in the current scope. Clear filters for the complete pass.', 5000);
}

$('#point-btn').onclick = () => {
  if ($('#point-btn').classList.contains('done')) { pointAdvance(); return; }
  // Point while already pointing at a target = "accept the current label as-is"
  if (state.template === 'relabel' && state.pointed) {
    const t = state.project.tasks[state.taskIdx];
    const group = relabelGroupOf(t);
    if (group.some(g => g.target === state.pointed) && state.labels[state.pointed]) {
      markReviewed(state.pointed);
      toast('Label accepted ✓');
    }
  }
  pointJump();
};

function updateLabeledCount() {
  const n = Object.values(state.labels).filter(entry => entry.label).length;
  const el = $('#st-labeled');
  if (state.template === 'relabel' && state.project) {
    // in relabel the meaningful number is how many of the 500 targets you've reviewed
    let rev = 0;
    for (const t of state.project.tasks) if (t.target && isReviewed(t.target)) rev++;
    el.textContent = `${rev} reviewed · ${n} labeled`;
  } else {
    el.textContent = `${n} rows`;
  }
}

/* ============================ nav ============================ */
/* Relabel mode: navigate THREAD by THREAD (merged view = one screen per thread).
   Threads with no 500-comment targets are never shown; Next skips threads that
   are already fully labeled. */
function threadKeyOf(t) { return t.threadId || ('i' + t.i); }

function relabelNavStep(dir) {
  const proj = state.project;
  const curKey = threadKeyOf(proj.tasks[state.taskIdx]);
  let i = state.taskIdx + dir;
  while (i >= 0 && i < proj.tasks.length) {
    const t = proj.tasks[i];
    const k = threadKeyOf(t);
    if (k === curKey) { i += dir; continue; }         // skip rest of current thread
    const group = proj.threadGroup.get(k) || [t];
    const has500 = group.some(g => g.target);          // thread must contain a 500-comment
    const pending = group.some(g => g.target && targetInScope(g) && !isReviewed(g.target));
    // Next: only threads with work left; Prev: any different thread (review)
    if (!t.blocked && has500 && (dir < 0 || pending)) { state.taskIdx = i; renderTask().catch(reportError); return; }
    while (i >= 0 && i < proj.tasks.length && threadKeyOf(proj.tasks[i]) === k) i += dir;  // skip whole thread
  }
  toast(dir > 0 ? '🎉 No threads left with unlabeled 500-comments — export your work!' : 'Start of project');
}

$('#btn-prev').onclick = () => {
  if (!state.project) return;
  if (state.template === 'relabel') relabelNavStep(-1);
  else navigateQueue(-1);
};
$('#btn-next').onclick = () => {
  if (!state.project) return;
  if (state.template === 'relabel') relabelNavStep(1);
  else navigateQueue(1);
};
function navigateQueue(direction) {
  const tasks = queueTasks(), current = state.project.tasks[state.taskIdx];
  const index = tasks.findIndex(task => threadKeyOf(task) === threadKeyOf(current));
  const next = tasks[index + direction];
  if (next) { state.taskIdx = state.project.tasks.indexOf(next); renderTask().catch(reportError); }
}
/* Focus / Full-thread toggle — the megathreads hold ~12k nodes, which is what
   made Point unreliable. Focused view = each target's reply chain + its siblings. */
function toggleFocus() {
  const proj = state.project;
  if (!proj) return;
  proj.focus = proj.focus === 'full' ? 'focus' : 'full';
  updateFocusBtn();
  renderTask().catch(reportError);
}
function updateFocusBtn() {
  const proj = state.project;
  if (!proj) return;
  const full = proj.focus === 'full';
  $('#btn-focus').textContent = full ? 'Focus' : 'Full thread';
  $('#btn-focus').classList.toggle('orange', !full);
  $('#btn-focus').title = full
    ? 'Show only each target’s reply chain and its siblings (fast)'
    : 'Focused view is on — click for the full thread';
}
$('#btn-focus').onclick = toggleFocus;
document.addEventListener('click', e => {          // the link inside the focus notice
  if (e.target && e.target.id === 'focus-hint') toggleFocus();
});
document.addEventListener('keydown', e => {
  if ($('#workspace').hidden) return;
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (state.busy || $$('.overlay').some(overlay => !overlay.hidden)) return;
  if (e.key === 'ArrowLeft') $('#btn-prev').click();
  if (e.key === 'ArrowRight') $('#btn-next').click();
});

/* ============================ settings (data caps) ============================ */
$('#btn-settings').onclick = () => {
  if (!state.project) return;
  const caps = state.project.caps || {};
  document.getElementById('set-depth').value = caps.depth || '';
  document.getElementById('set-total').value = caps.total || '';
  window.FilterPreview?.refresh('set');
  const blocked = state.project.tasks.filter(t => t.blocked).length;
  document.getElementById('set-status').textContent =
    `${state.project.threadGroup.size} unique threads · ` +
    (blocked ? `${blocked} source tasks beyond the comment budget` : 'all threads reachable');
  $('#settings-modal').hidden = false;
  $('#set-depth').focus();
};

$('#btn-reset-filters').onclick = () => {
  $('#set-depth').value = '';
  $('#set-total').value = '';
  window.FilterPreview?.refresh('set');
};
$('#btn-apply-settings').onclick = async () => {
  if (state.busy) return;
  const proj = state.project;
  let caps;
  try { caps = readCapInputs(['set-depth', 'set-total']); } catch { return; }
  const previous = proj.caps;
  setWorkspaceBusy(true);
  try {
    proj.caps = caps;
    await computeBlocked(proj);
    saveCaps(proj.name, caps);
    if (proj.tasks[state.taskIdx].blocked) state.taskIdx = proj.tasks.findIndex(task => !task.blocked);
    $('#settings-modal').hidden = true;
    await renderTask();
    toast('Filters applied');
  } catch (error) {
    proj.caps = previous;
    await computeBlocked(proj).catch(reportError);
    reportError(error);
  } finally {
    setWorkspaceBusy(false);
  }
};

/* ============================ modals plumbing ============================ */
$$('[data-close]').forEach(b => b.onclick = () => b.closest('.overlay').hidden = true);
$$('.overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o && o.id !== 'auth-gate') o.hidden = true; }));
$$('.modal').forEach(modal => {
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const heading = modal.querySelector('h3');
  if (!heading.id) heading.id = modal.closest('.overlay').id + '-title';
  modal.setAttribute('aria-labelledby', heading.id);
  modal.querySelectorAll('.closebtn').forEach(button => button.setAttribute('aria-label', 'Close dialog'));
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') $$('.overlay').forEach(o => { if (o.id !== 'auth-gate') o.hidden = true; });
  if (e.key === 'Tab') {
    const modal = $$('.overlay').find(overlay => !overlay.hidden);
    if (!modal) return;
    const controls = [...modal.querySelectorAll('button, input, select, a[href]')].filter(control => !control.disabled && control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!controls.includes(document.activeElement) || (!e.shiftKey && document.activeElement === last)) { e.preventDefault(); first?.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  }
});

/* ============================ boot ============================ */
renderHome();
async function restoreRoute() {
  const legacy = location.hash.match(/^#t(\d+)$/);
  const route = new URLSearchParams(location.hash.slice(1));
  const name = route.get('p') || (legacy ? SKELETON : '');
  const taskId = +(route.get('t') || legacy?.[1] || 0);
  if (!name) return;
  const entry = loadProjectList().find(project => project.name === name);
  if (entry) await openSavedProject(name, entry.pre500 ? 'point' : 'thread', entry.pre500 ? 'relabel' : 'full');
  else if (name === SKELETON) await openSkeletonProject(name);
  else { toast('This project is not saved in this browser.'); return; }
  const idx = state.project.tasks.findIndex(task => task.i === taskId && !task.blocked);
  if (idx >= 0) { state.taskIdx = idx; await renderTask(); }
}
restoreRoute().catch(error => { reportError(error); backHome(); });
