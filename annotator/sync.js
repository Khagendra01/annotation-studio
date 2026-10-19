'use strict';
/* Cloud sync for the annotator.
   localStorage stays the source of truth the UI reads; Supabase mirrors it.
   Writes are announced by AnnotationRepository (window.__repoChanged) and sent
   as debounced diffs against the last known server state (snaps).
   Tables: projects / annotations / positions — see supabase/migrations/. */
window.RemoteSync = (() => {
  const K = {
    projects: 'annotator.projects.v1',
    labels: n => 'annotator.labels.v1.' + n,
    caps: n => 'annotator.caps.v1.' + n,
    pos: n => 'annotator.pos.v1.' + n,
    deleted: 'annotator.deleted-projects.v1',
  };
  const P = {
    projects: 'annotator.projects.v1',
    labels: 'annotator.labels.v1.',
    caps: 'annotator.caps.v1.',
    pos: 'annotator.pos.v1.',
  };
  const CHUNK = 800;      // rows per upsert / delete
  const PAGE = 1000;      // rows per pull page
  const repo = new window.AnnotationRepository();

  let signedIn = false;
  let hydrating = 0;                 // >0 while pull writes back into localStorage
  let pulledOnce = false;            // only then may missing remote projects be deleted
  const ids = new Map();             // project name -> uuid
  const snaps = new Map();           // project name -> Map(node -> fingerprint) of server state
  const timers = new Map();          // debounce timers
  let chain = Promise.resolve();
  let status = 'off';                // off | syncing | ok | error
  let lastSync = 0;
  let lastError = '';
  let generation = 0;
  let accountId = null;

  const staleSession = () => Object.assign(new Error('The signed-in account changed.'), { staleSession: true });
  const sb = () => {
    if (!signedIn || window.AuthGate.user()?.id !== accountId) throw staleSession();
    return window.AuthGate.client();
  };
  const user = () => window.AuthGate.user();
  const fp = e => (e ? `${e.label ?? ''}|${e.rev ? 1 : 0}|${e.task_id ?? e.taskId ?? ''}` : '');
  const clock = t => new Date(t).toTimeString().slice(0, 8);

  async function checked(query) {
    const current = generation;
    const result = await query;
    if (!signedIn || current !== generation || user()?.id !== accountId) throw staleSession();
    return result;
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function render() {
    const el = document.getElementById('st-sync');
    if (!el) return;
    if (!window.AuthGate.isConfigured()) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('err', status === 'error');
    if (!signedIn) { el.textContent = 'cloud: signed out'; el.title = 'Sign in to sync'; return; }
    if (status === 'syncing') { el.textContent = 'cloud: syncing…'; el.title = 'Pushing and pulling annotations'; return; }
    if (status === 'error') {
      el.textContent = 'cloud: sync error';
      el.title = (lastError || 'Unknown error') + ' — click to retry';
      return;
    }
    el.textContent = 'cloud: synced ' + clock(lastSync);
    el.title = 'Supabase sync — click to sync now';
  }

  function ok() { status = 'ok'; lastSync = Date.now(); lastError = ''; render(); }
  function fail(error) {
    if (error?.staleSession) return;
    console.error('[RemoteSync]', error);
    status = 'error';
    lastError = error && error.message ? error.message : String(error);
    render();
  }
  /* Serialise every remote operation so pulls and pushes never interleave.
     schedule() is fire-and-forget; run() rethrows to its caller. */
  function schedule(fn) {
    const current = generation;
    chain = chain.then(async () => {
      if (!signedIn || current !== generation) return;
      status = 'syncing'; render();
      await fn();
      if (signedIn && current === generation) ok();
    }).catch(fail);
    return chain;
  }
  async function run(fn) {
    const current = generation;
    const task = chain.then(() => (signedIn && current === generation ? fn() : null));
    chain = task.catch(fail);          // keep the chain usable after a failure
    return task;
  }
  function later(key, fn, ms = 1200) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); schedule(fn); }, ms));
  }

  /* ---------- repository hook ---------- */
  window.__repoChanged = (type, key, storage) => {
    if (storage !== window.localStorage) return;
    if (!signedIn || hydrating) return;
    if (key === P.projects || key === K.deleted || key.startsWith(P.caps)) later('projects', pushProjects, 900);
    else if (key.startsWith(P.labels)) later('labels:' + key.slice(P.labels.length), () => pushLabels(key.slice(P.labels.length)));
    else if (key.startsWith(P.pos)) later('pos:' + key.slice(P.pos.length), () => pushPos(key.slice(P.pos.length)), 700);
    // annotator.data.v1.* holds imported CSV rows — source data stays local
  };

  /* ---------- remote helpers ---------- */
  async function fetchAnnotations(pid) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await checked(sb()
        .from('annotations')
        .select('node_id,label,task_id,reviewed')
        .eq('project_id', pid)
        .eq('reviewer_id', user().id)
        .order('node_id')
        .range(from, from + PAGE - 1));
      if (error) throw error;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  }

  function projectRow(entry) {
    const caps = repo.get(K.caps(entry.name), {}) || {};
    return {
      owner_id: user().id,
      name: entry.name,
      meta: {
        skeleton: !!entry.skeleton,
        pre500: !!entry.pre500,
        imported: !!entry.imported,
        created: entry.created || null,
      },
      caps,
      updated_at: new Date().toISOString(),
    };
  }

  async function upsertProject(entry) {
    const { data, error } = await checked(sb()
      .from('projects')
      .upsert(projectRow(entry), { onConflict: 'owner_id,name' })
      .select('id')
      .single());
    if (error) throw error;
    ids.set(entry.name, data.id);
    return data.id;
  }

  async function ensureId(name) {
    if (ids.has(name)) return ids.get(name);
    const entry = (repo.get(K.projects, []) || []).find(p => p.name === name);
    if (!entry) throw new Error('Project no longer exists: ' + name);
    return upsertProject(entry);
  }

  /* ---------- pull ---------- */
  async function pullLabels(pid, name) {
    const rows = await fetchAnnotations(pid);
    if ((repo.get(K.deleted, []) || []).includes(name)) return;
    if (typeof state !== 'undefined' && state.project?.name === name && typeof saveLabels === 'function') saveLabels(true);
    const remote = new Map(rows.map(r => [r.node_id, `${r.label ?? ''}|${r.reviewed ? 1 : 0}|${r.task_id ?? ''}`]));
    const local = repo.get(K.labels(name), {}) || {};
    const snap = snaps.get(name);
    let changed = false;

    for (const r of rows) {
      const node = r.node_id;
      const entry = local[node];
      if (!entry) {
        if (snap?.has(node)) continue; // A local removal must reach the server before a pull can restore it.
        local[node] = { label: r.label ?? '', taskId: r.task_id ?? undefined, rev: !!r.reviewed };
        changed = true;
        continue;
      }
      if (fp(entry) === remote.get(node)) continue;
      // Local differs from the server: only take the server copy when the local
      // entry is untouched since the last sync (otherwise the local edit wins).
      if ((snap && snap.get(node) === fp(entry)) || (!snap && !entry.rev && entry.label)) {
        local[node] = { ...entry, label: r.label ?? '', taskId: r.task_id ?? entry.taskId, rev: !!r.reviewed };
        changed = true;
      }
    }
    if (snap) {
      for (const node of snap.keys()) {
        if (remote.has(node)) continue;
        const entry = local[node];
        if (entry && snap.get(node) === fp(entry)) { delete local[node]; changed = true; }
      }
    }
    if (changed) {
      hydrating++;
      try { repo.set(K.labels(name), local); } finally { hydrating--; }
      applyToOpenProject(name, local);
    }
    snaps.set(name, remote);          // server state only — dirty local rows still need pushing
  }

  async function pullPos(pid, name) {
    const { data, error } = await checked(sb()
      .from('positions')
      .select('position')
      .eq('project_id', pid)
      .eq('reviewer_id', user().id)
      .maybeSingle());
    if (error) throw error;
    if (!data) return;
    const local = Number(repo.get(K.pos(name), 0)) || 0;
    const remote = Number(data.position) || 0;
    if (remote > local) {              // furthest progress wins
      hydrating++;
      try { repo.set(K.pos(name), remote); } finally { hydrating--; }
    }
  }

  async function pullProject(name) {
    const pid = await ensureId(name);
    hydrating++;
    try {
      await pullLabels(pid, name);
      await pullPos(pid, name);
    } finally { hydrating--; }
  }

  async function pullAll() {
    const { data: projects, error } = await checked(sb()
      .from('projects')
      .select('id,name,meta,caps,created_at')
      .eq('owner_id', user().id)
      .order('created_at'));
    if (error) throw error;

    hydrating++;
    try {
      const list = repo.get(K.projects, []) || [];
      let listChanged = false;
      const deleted = new Set(repo.get(K.deleted, []));
      for (const p of projects) {
        ids.set(p.name, p.id);
        if (deleted.has(p.name)) continue;
        if (!list.some(x => x.name === p.name)) {
          list.push({ name: p.name, ...(p.meta || {}), created: p.created || (p.meta || {}).created || 0 });
          listChanged = true;
        }
        const localCaps = repo.get(K.caps(p.name), null);
        if ((!localCaps || !Object.keys(localCaps).length) && p.caps && Object.keys(p.caps).length) {
          repo.set(K.caps(p.name), p.caps);
        }
        await pullLabels(p.id, p.name);
        await pullPos(p.id, p.name);
      }
      if (listChanged) {
        const deletedNow = new Set(repo.get(K.deleted, []));
        const current = repo.get(K.projects, []) || [];
        for (const project of list) {
          if (!deletedNow.has(project.name) && !current.some(entry => entry.name === project.name)) current.push(project);
        }
        repo.set(K.projects, current.filter(project => !deletedNow.has(project.name)));
      }
    } finally {
      hydrating--;
    }
    pulledOnce = true;

    // Local-only projects (and any local edits kept during the merge) go up now.
    await pushProjects();
    for (const name of (repo.get(K.projects, []) || []).map(p => p.name)) {
      await pushLabels(name);
      await pushPos(name);
    }
    refreshHome();
    ok();
  }

  function applyToOpenProject(name, labels) {
    try {
      if (typeof state === 'undefined' || !state.project || state.project.name !== name) return;
      state.labels = labels;
      for (const control of document.querySelectorAll?.('.labelctl') || []) {
        const label = labels[control.dataset.node]?.label || '';
        const select = control.querySelector('.label-select');
        if (select) select.value = label;
        const chip = control.querySelector('.chip');
        if (chip) { chip.textContent = label.replaceAll('_', ' '); chip.classList.toggle('set', !!label); }
      }
      if (typeof updateLabeledCount === 'function') updateLabeledCount();
      if (typeof updatePointUI === 'function') updatePointUI();
    } catch (error) { console.error('[RemoteSync]', error); }
  }

  function refreshHome() {
    const home = document.getElementById('home');
    if (home && !home.hidden && typeof renderHome === 'function') renderHome();
  }

  /* ---------- push ---------- */
  async function pushProjects() {
    const list = repo.get(K.projects, []) || [];
    for (const entry of list) if (entry && entry.name) await upsertProject(entry);
    const deleted = new Set(repo.get(K.deleted, []));
    if (pulledOnce && deleted.size) {
      const { data: remote, error } = await checked(sb().from('projects').select('id,name').eq('owner_id', user().id));
      if (error) throw error;
      for (const idsChunk of chunk(remote.filter(r => deleted.has(r.name)).map(r => r.id), 200)) {
        const { error: delError } = await checked(sb().from('projects').delete().in('id', idsChunk));
        if (delError) throw delError;
      }
    }
    render();
  }

  async function pushLabels(name) {
    if (!name || !(repo.get(K.projects, []) || []).some(project => project.name === name)) return;
    if (!snaps.has(name)) await pullProject(name);   // know the server state before diffing
    if (!(repo.get(K.projects, []) || []).some(project => project.name === name)) return;
    const pid = ids.get(name);
    const uid = user().id;
    const local = repo.get(K.labels(name), {}) || {};
    const snap = snaps.get(name) || new Map();
    const upserts = [];
    const removals = [];

    for (const [node, entry] of Object.entries(local)) {
      if (!entry) continue;
      if (snap.get(node) === fp(entry)) continue;
      upserts.push({
        project_id: pid,
        node_id: node,
        reviewer_id: uid,
        label: entry.label ?? null,
        task_id: entry.taskId ?? null,
        reviewed: !!entry.rev,
        updated_at: new Date().toISOString(),
      });
    }
    for (const node of snap.keys()) if (!(node in local)) removals.push(node);
    if (!upserts.length && !removals.length) return;

    for (const part of chunk(upserts, CHUNK)) {
      const { error } = await checked(sb().from('annotations').upsert(part, { onConflict: 'project_id,node_id,reviewer_id' }));
      if (error) throw error;
    }
    for (const part of chunk(removals, CHUNK)) {
      const { error } = await checked(sb().from('annotations')
        .delete().eq('project_id', pid).eq('reviewer_id', uid).in('node_id', part));
      if (error) throw error;
    }
    snaps.set(name, new Map(Object.entries(local).map(([node, entry]) => [node, fp(entry)])));
    render();
  }

  async function pushPos(name) {
    if (!name || !(repo.get(K.projects, []) || []).some(project => project.name === name)) return;
    const pid = await ensureId(name);
    if (!(repo.get(K.projects, []) || []).some(project => project.name === name)) return;
    const position = Number(repo.get(K.pos(name), 0)) || 0;
    const { error } = await checked(sb().from('positions').upsert(
      { project_id: pid, reviewer_id: user().id, position, updated_at: new Date().toISOString() },
      { onConflict: 'project_id,reviewer_id' },
    ));
    if (error) throw error;
    render();
  }

  /* ---------- lifecycle ---------- */
  async function signIn() {
    if (!window.AuthGate.isConfigured()) return;
    if (!user()) throw new Error('not signed in');
    const uid = user().id;
    if (signedIn && accountId !== uid) signOut();
    try { window.AnnotationRepository.useAccount(uid); }
    catch (error) { error.blockWorkspace = true; throw error; }
    accountId = uid;
    signedIn = true;
    generation++;
    status = 'syncing';
    render();
    try {
      await run(pullAll);
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  function signOut() {
    signedIn = false;
    generation++;
    chain = Promise.resolve();
    if (typeof backHome === 'function') backHome();
    document.getElementById('file-list')?.replaceChildren();
    accountId = null;
    pulledOnce = false;
    ids.clear();
    snaps.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    status = 'off';
    render();
  }

  async function syncNow() {
    if (!signedIn) return;
    if (typeof saveLabels === 'function') saveLabels(true);
    status = 'syncing';
    render();
    try { await run(pullAll); } catch (error) { fail(error); }
  }

  window.addEventListener('pagehide', () => {          // last-chance flush
    if (!signedIn) return;
    for (const [key, timer] of timers) {
      clearTimeout(timer);
      timers.delete(key);
      if (key.startsWith('labels:')) schedule(() => pushLabels(key.slice(7)));
      else if (key.startsWith('pos:')) schedule(() => pushPos(key.slice(4)));
      else if (key === 'projects') schedule(pushProjects);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
  });
  const statusEl = document.getElementById('st-sync');
  if (statusEl) statusEl.addEventListener('click', syncNow);
  document.addEventListener('DOMContentLoaded', render);
  render();

  return { signIn, signOut, syncNow };
})();
