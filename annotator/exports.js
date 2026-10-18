'use strict';
/* ============================ export modal ============================ */
$('#btn-export').onclick = () => {
  if (!state.project) return;
  const n = Object.keys(state.labels).length;
  $('#export-progress').textContent = `${n} labeled node${n === 1 ? '' : 's'} in “${state.project.name}”`;
  $('#export-modal').hidden = false;
  renderExportPreviews();
};

/* live sample of what each checked export actually produces (from loaded data) */
const EXP_SAMPLE = 3;
const expClip = (v, n = 70) => {
  const s = String(v ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function expLabeledCsvSample() {
  const proj = state.project;
  const triples = labeledRowTriples().slice(0, EXP_SAMPLE);
  if (!triples.length) return 'nothing labeled yet';
  const lines = [proj.columns.join(',')];
  for (const t of triples) {
    const r = t.row.slice();
    r[proj.colIdx['label'] ?? r.length - 1] = t.label;
    if (proj.colIdx['text'] !== undefined) r[proj.colIdx['text']] = expClip(r[proj.colIdx['text']]);
    lines.push(r.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function expLabeledJsonSample() {
  const proj = state.project;
  const triples = labeledRowTriples().slice(0, 2);
  if (!triples.length) return 'nothing labeled yet';
  const obj = triples.map(t => {
    const o = {};
    proj.columns.forEach((c, i) => o[c] = c === 'text' ? expClip(t.row[i]) : (t.row[i] ?? ''));
    o.label = t.label;
    return o;
  });
  return JSON.stringify(obj, null, 1);
}

function expFullCsvSample() {
  const proj = state.project;
  const t = proj.tasks.find(x => x.rawRows?.length);
  if (!t) return 'no chunks loaded yet — export loads them all first';
  const lines = [proj.columns.join(',')];
  for (const r of t.rawRows.slice(0, EXP_SAMPLE)) {
    const rr = r.slice();
    const id = rr[proj.colIdx['node_id']];
    rr[proj.colIdx['label'] ?? rr.length - 1] = state.labels[id]?.label || rr[proj.colIdx['label']] || '';
    if (proj.colIdx['text'] !== undefined) rr[proj.colIdx['text']] = expClip(rr[proj.colIdx['text']]);
    lines.push(rr.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function expTsvSample() {
  const proj = state.project;
  const triples = labeledRowTriples().slice(0, EXP_SAMPLE);
  if (!triples.length) return 'nothing labeled yet';
  const cell = v => expClip(String(v ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ⏎ '), 50);
  const head = ['task_index', 'node_id', 'parent_id', 'role', 'label', 'text'].join('\t');
  const body = triples.map(t => {
    const r = t.row;
    return [t.taskId, t.id, cell(col(proj, 'parent_id', r)), cell(col(proj, 'role', r)), t.label, cell(col(proj, 'text', r))].join('\t');
  });
  return [head, ...body].join('\n');
}

function exp500Sample() {
  const proj = state.project;
  const rows500 = proj.tasks
    .filter(t => t.target && (t.oldLabel !== undefined || t.unrecovered))
    .sort((a, b) => (a.sourceRow || 1e9) - (b.sourceRow || 1e9));
  if (!rows500.length) return 'no 500-file annotations in this project';
  const lines = ['post_id,post_text,class_label'];
  for (const t of rows500.slice(0, EXP_SAMPLE)) {
    const pid = t.unrecovered || t.postId || t.target.replace(/^t[13]_/, '');
    const lab = state.labels[t.target]?.label;
    const text = t.unrecovered ? (t.rawRows?.[0]?.[proj.colIdx['text']] ?? '') : (t.targetText || '');
    lines.push([pid, expClip(text), lab ?? t.oldLabel ?? ''].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

const EXP_PREVIEWS = {
  'labeled-csv': expLabeledCsvSample,
  'labeled-json': expLabeledJsonSample,
  'full-csv': expFullCsvSample,
  'labels-tsv': expTsvSample,
  'five-hundred': exp500Sample,
};

function renderExportPreviews() {
  $$('#export-opts .exportopt').forEach(l => {
    const box = l.querySelector('input');
    l.classList.toggle('sel', box.checked);
    const pre = l.querySelector('.expreview');
    pre.textContent = box.checked ? EXP_PREVIEWS[l.dataset.opt]() : '';
  });
}
$$('#export-opts .exportopt input').forEach(box => box.onchange = renderExportPreviews);

function labeledRowTriples() {
  const proj = state.project;
  const out = [];
  for (const [id, e] of Object.entries(state.labels)) {
    if (!e.row) continue;
    out.push({ taskId: e.taskId, id, label: e.label, row: e.row });
  }
  out.sort((a, b) => a.taskId - b.taskId || a.id.localeCompare(b.id));
  return out;
}

async function loadAllChunks() {
  const proj = state.project;
  if (!proj.dataDir) return;
  const total = proj.chunked.chunks.length;
  for (let c = 1; c <= total; c++) {
    if (attachChunkRows(proj, c)) continue;      // already in global cache
    $('#export-progress').textContent = `loading chunk ${c}/${total}…`;
    await injectScript(`data_annotated/${proj.dataDir}/c${String(c).padStart(2, '0')}.js`);
    attachChunkRows(proj, c);
  }
}

$('#btn-do-export').onclick = async () => {
  const proj = state.project;
  const kinds = $$('#export-opts input:checked').map(b => b.value);
  if (!kinds.length) return toast('Check at least one export');
  const prog = $('#export-progress');
  const done = [];
  try {
    for (const kind of kinds) {
      if (kind === 'labeled-csv') {
        prog.textContent = 'collecting rows…';
        const triples = labeledRowTriples();
        if (!triples.length) { toast('Nothing labeled yet — skipped CSV'); continue; }
        const lines = [proj.columns.join(',')];
        for (const t of triples) {
          const r = t.row.slice();
          r[proj.colIdx['label'] ?? r.length - 1] = t.label;
          lines.push(r.map(csvEscape).join(','));
        }
        download(`${proj.name}-labeled.csv`, 'text/csv', lines.join('\n'));
        done.push(`${triples.length} labeled rows → CSV`);
      } else if (kind === 'labeled-json') {
        const triples = labeledRowTriples();
        if (!triples.length) { toast('Nothing labeled yet — skipped JSON'); continue; }
        const obj = triples.map(t => {
          const o = {};
          proj.columns.forEach((c, i) => o[c] = t.row[i] ?? '');
          o.label = t.label;
          return o;
        });
        download(`${proj.name}-labeled.json`, 'application/json', JSON.stringify(obj, null, 1));
        done.push(`${obj.length} labeled rows → JSON`);
      } else if (kind === 'full-csv') {
        prog.textContent = 'collecting rows…';
        await loadAllChunks();
        const lines = [proj.columns.join(',')];
        let n = 0;
        for (const t of proj.tasks) {
          for (const r of (t.rawRows || [])) {
            const rr = r.slice();
            const id = rr[proj.colIdx['node_id']];
            const lab = state.labels[id]?.label || rr[proj.colIdx['label']] || '';
            rr[proj.colIdx['label'] ?? rr.length - 1] = lab;
            lines.push(rr.map(csvEscape).join(','));
            n++;
          }
        }
        download(`${proj.name}-full.csv`, 'text/csv', lines.join('\n'));
        done.push(`${n.toLocaleString()} rows → full CSV`);
      } else if (kind === 'labels-tsv') {
        const triples = labeledRowTriples();
        if (!triples.length) { toast('Nothing labeled yet — skipped TSV'); continue; }
        const head = ['task_index', 'node_id', 'parent_id', 'role', 'label', 'text'].join('\t');
        const body = triples.map(t => {
          const r = t.row;
          const cell = v => String(v ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ⏎ ');
          return [t.taskId, t.id, cell(col(proj, 'parent_id', r)), cell(col(proj, 'role', r)), t.label, cell(col(proj, 'text', r))].join('\t');
        });
        await navigator.clipboard.writeText([head, ...body].join('\n'));
        done.push(`${triples.length} rows → clipboard (TSV)`);
      } else if (kind === 'five-hundred') {
        // one row per original 500-file annotation, in the source file's own order
        const rows500 = proj.tasks.filter(t => t.target && (t.oldLabel !== undefined || t.unrecovered));
        if (!rows500.length) { toast('No 500-file annotations — skipped'); continue; }
        rows500.sort((a, b) => (a.sourceRow || 1e9) - (b.sourceRow || 1e9));
        const lines = ['post_id,post_text,class_label'];
        let unlabeled = 0;
        for (const t of rows500) {
          const pid = t.unrecovered || t.postId || t.target.replace(/^t[13]_/, '');
          const lab = state.labels[t.target]?.label;
          if (lab === undefined || lab === '') unlabeled++;
          const text = t.unrecovered ? (t.rawRows?.[0]?.[proj.colIdx['text']] ?? '') : (t.targetText || '');
          lines.push([pid, text, lab ?? t.oldLabel ?? ''].map(csvEscape).join(','));
        }
        download('la_fires_reddits_relabelled_500.csv', 'text/csv', lines.join('\n'));
        done.push(`500 rows → relabelled CSV${unlabeled ? ` (${unlabeled} kept original label)` : ''}`);
      }
    }
    prog.textContent = '';
    if (done.length) toast('Exported — ' + done.join(' · '), 5000);
    $('#export-modal').hidden = true;
  } catch (e) {
    console.error(e);
    prog.textContent = '';
    toast('Export failed: ' + e.message, 4000);
  }
};

