'use strict';
let exportBusy = false;
/* ============================ export modal ============================ */
$('#btn-export').onclick = () => {
  if (!state.project) return;
  renderExportSample();
  $('#export-modal').hidden = false;
};

function renderExportSummary() {
  if (!state.project || exportBusy) return;
  const ids = Object.keys(state.labels).filter(id => savedLabel({ id }));
  const schema = $('input[name="exp-schema"]:checked').value;
  const scope = $('input[name="exp-scope"]:checked').value;
  const targets = new Set(state.project.tasks.map(task => task.target).filter(Boolean));
  const count = schema === 'tree' || schema === '500' ? ids.filter(id => targets.has(id)).length : ids.length;
  $('#export-progress').textContent = `${ids.length} saved label${ids.length === 1 ? '' : 's'} in “${state.project.name}” · `
    + (scope === 'labeled' ? `${count} labeled row${count === 1 ? '' : 's'} selected` : 'Full project selected');
}

async function loadAllChunks(proj) {
  if (!proj.dataDir) return;
  const total = proj.chunked.chunks.length;
  for (let c = 1; c <= total; c++) {
    if (state.project !== proj) throw new Error('The project changed during export. Please try again.');
    if (attachChunkRows(proj, c)) continue;
    $('#export-progress').textContent = `loading chunk ${c}/${total}…`;
    await injectScript(`data_annotated/${proj.dataDir}/c${String(c).padStart(2, '0')}.js`);
    if (state.project !== proj) throw new Error('The project changed during export. Please try again.');
    attachChunkRows(proj, c);
  }
}

function taskRows(proj, unique = false, savedOnly = false) {
  const rows = [], byId = new Map();
  proj.tasks.forEach((task, i) => (task.rawRows || task.rows || []).forEach(row => {
    const id = col(proj, 'node_id', row);
    if (savedOnly && !savedLabel({ id })) return;
    const entry = { taskId: task.i ?? i, task, row, id, label: state.labels[id]?.label ?? col(proj, 'label', row) ?? '' };
    if (!unique) rows.push(entry);
    else {
      const previous = byId.get(id);
      if (!previous || (savedOnly ? state.labels[id]?.taskId === entry.taskId
        : col(proj, 'role', previous.row) !== 'target' && col(proj, 'role', row) === 'target')) byId.set(id, entry);
    }
  }));
  return unique ? [...byId.values()] : rows;
}

function effectiveLabel(entry) {
  return state.labels[entry.id]?.label ?? entry.label ?? '';
}

function savedLabel(entry) {
  const saved = state.labels[entry.id];
  return saved?.rev ? saved.label ?? '' : '';
}

function sourceObject(proj, entry, schema) {
  const values = Object.create(null);
  proj.columns.forEach((name, i) => {
    values[name] = name === 'label' ? effectiveLabel(entry) : (entry.row[i] ?? '');
  });
  if (proj.colIdx.label === undefined) values.label = effectiveLabel(entry);
  if (schema !== 'node') return values;

  const priority = ['task_index', 'node_id', 'parent_id', 'role', 'label', 'text'];
  const ordered = Object.create(null);
  for (const key of priority) {
    ordered[key] = key === 'task_index' ? entry.taskId : (values[key] ?? '');
  }
  for (const key of proj.columns) if (!priority.includes(key)) ordered[key] = values[key] ?? '';
  return ordered;
}

const EXP_SAMPLE_PATH = [
  { node_id: 't3_1hwabc', role: 'op', text: 'Where can families find shelter tonight?' },
  { node_id: 't1_m8abc', role: 'comment', text: 'The community center is open and accepting evacuees.' },
  { node_id: 't1_m8xyz', role: 'target', text: 'Do they have room for pets too?' },
];
const EXP_SAMPLE_SCHEMAS = {
  original: {
    name: 'Original project columns',
    headers: ['task_index', 'thread_id', 'node_id', 'parent_id', 'role', 'created_utc', 'state', 'replies', 'is_target', 'text', 'label'],
    row: ['12', '1hwabc', 't1_m8xyz', 't3_1hwabc', 'target', '2025-01-08 06:40 UTC', 'present', '2', '1', 'Do they have room for pets too?', 'requests_or_urgent_needs'],
  },
  node: {
    name: 'Thread rows',
    headers: ['task_index', 'node_id', 'parent_id', 'role', 'label', 'text', 'thread_id', 'created_utc', 'state', 'replies', 'is_target'],
    row: ['12', 't1_m8xyz', 't3_1hwabc', 'target', 'requests_or_urgent_needs', 'Do they have room for pets too?', '1hwabc', '2025-01-08 06:40 UTC', 'present', '2', '1'],
  },
  '500': {
    name: 'Relabeled 500 format',
    headers: ['post_id', 'post_text', 'class_label'],
    row: ['m8xyz', 'Do they have room for pets too?', 'requests_or_urgent_needs'],
  },
  tree: {
    name: 'Target with full tree path',
    headers: ['post_id', 'tree_path', 'class_label'],
    row: ['m8xyz', EXP_SAMPLE_PATH, 'requests_or_urgent_needs'],
  },
};

function renderExportSample() {
  const schema = $('input[name="exp-schema"]:checked').value;
  const format = $('input[name="exp-format"]:checked').value;
  const sample = EXP_SAMPLE_SCHEMAS[schema];
  $('#export-sample-name').textContent = sample.name;
  const host = $('#export-sample-table');
  host.replaceChildren();
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const key of sample.headers) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = key;
    head.appendChild(cell);
  }
  const row = table.createTBody().insertRow();
  sample.row.forEach(value => {
    const cell = row.insertCell();
    cell.textContent = keyForSample(schema, value, format);
  });
  host.appendChild(table);
  renderExportSummary();
}

function keyForSample(schema, value, format) {
  if (schema !== 'tree' || !Array.isArray(value)) return String(value);
  return JSON.stringify(value, null, format === 'json' ? 2 : 0);
}

$$('input[name="exp-schema"], input[name="exp-format"]').forEach(input => input.addEventListener('change', renderExportSample));
$$('input[name="exp-scope"]').forEach(input => input.addEventListener('change', renderExportSummary));
renderExportSample();

function fiveHundredEntries(proj) {
  const seen = new Set();
  return proj.tasks.map((task, i) => ({ task, taskId: task.i ?? i }))
    .filter(({ task }) => {
      if (!task.target || seen.has(task.target)) return false;
      seen.add(task.target);
      return true;
    })
    .sort((a, b) => (a.task.sourceRow ?? 1e9) - (b.task.sourceRow ?? 1e9))
    .map(({ task, taskId }) => {
      const id = task.target;
      const row = task.rawRows?.find(r => col(proj, 'node_id', r) === id) || task.rows?.find(r => col(proj, 'node_id', r) === id) || [];
      const originalText = task.unrecovered ? (task.rawRows?.[0]?.[proj.colIdx.text] ?? '') : (task.targetText || col(proj, 'text', row) || '');
      return { task, taskId, row, id, label: state.labels[id]?.label ?? task.oldLabel ?? col(proj, 'label', row) ?? '', postId: task.unrecovered || task.postId || id.replace(/^t[13]_/, ''), text: originalText };
    });
}

function treePath(proj, entry) {
  const rows = entry.task.rawRows || entry.task.rows || [];
  const byId = new Map(rows.map(row => [col(proj, 'node_id', row), row]));
  const path = [];
  const visited = new Set();
  let row = byId.get(entry.id);
  while (row) {
    const id = col(proj, 'node_id', row);
    if (visited.has(id)) throw new Error(`Tree path for ${entry.id} contains a parent cycle.`);
    visited.add(id);
    path.unshift({ node_id: col(proj, 'node_id', row) || '', role: col(proj, 'role', row) || '', text: col(proj, 'text', row) || '' });
    const parent = col(proj, 'parent_id', row);
    if (col(proj, 'role', row) === 'op') break;
    if (parent && !byId.has(parent)) throw new Error(`Tree path for ${entry.id} is missing parent ${parent}.`);
    row = parent ? byId.get(parent) : null;
  }
  if (!path.length && entry.text) path.push({ node_id: entry.id, role: 'target', text: entry.text });
  return path;
}

function asCsv(headers, objects) {
  const lines = [headers.map(csvEscape).join(',')];
  objects.forEach(obj => lines.push(headers.map(key => csvEscape(obj[key] ?? '')).join(',')));
  return lines.join('\n');
}

$('#btn-do-export').onclick = async () => {
  if (exportBusy || !state.project) return;
  const proj = state.project;
  const format = $('input[name="exp-format"]:checked').value;
  const scope = $('input[name="exp-scope"]:checked').value;
  const schema = $('input[name="exp-schema"]:checked').value;
  const prog = $('#export-progress');
  const controls = $$('#export-modal input, #export-modal button');
  const disabled = controls.map(control => control.disabled);
  exportBusy = true;
  controls.forEach(control => control.disabled = true);
  setWorkspaceBusy(true);
  $('#btn-do-export').textContent = 'Exporting…';
  try {
    await loadAllChunks(proj);
    if (state.project !== proj) throw new Error('The project changed during export. Please try again.');
    let objects;
    let filename = proj.name;
    if (schema === '500' || schema === 'tree') {
      objects = fiveHundredEntries(proj).filter(e => scope === 'full' || savedLabel(e) !== '').map(e => schema === '500'
        ? { post_id: e.postId, post_text: e.text, class_label: effectiveLabel(e) }
        : { post_id: e.postId, tree_path: treePath(proj, e), class_label: effectiveLabel(e) });
      filename += (scope === 'labeled' ? '-labeled' : '-full') + (schema === '500' ? '-relabelled-500' : '-relabelled-500-tree-path');
    } else {
      const selected = taskRows(proj, schema === 'node' || scope === 'labeled', scope === 'labeled');
      objects = selected.map(e => sourceObject(proj, e, schema));
      filename += scope === 'labeled' ? '-labeled' : '-full';
      filename += schema === 'node' ? '-threads' : '-original';
    }

    if (!objects.length) throw new Error(scope === 'labeled' ? 'No labeled rows to export.' : 'This project has no exportable rows.');
    if (format === 'json') {
      download(`${filename}.json`, 'application/json', JSON.stringify(objects, null, 2));
    } else {
      const headers = schema === '500' ? ['post_id', 'post_text', 'class_label']
        : schema === 'tree' ? ['post_id', 'tree_path', 'class_label']
          : schema === 'original' ? [...proj.columns, ...(proj.colIdx.label === undefined ? ['label'] : [])] : Object.keys(objects[0]);
      const csvObjects = schema === 'tree' ? objects.map(o => ({ ...o, tree_path: JSON.stringify(o.tree_path) })) : objects;
      download(`${filename}.csv`, 'text/csv', asCsv(headers, csvObjects));
    }
    prog.textContent = '';
    toast(`Exported ${objects.length.toLocaleString()} rows as ${format.toUpperCase()}.`, 4000);
    $('#export-modal').hidden = true;
  } catch (e) {
    console.error(e);
    prog.textContent = 'Export failed: ' + e.message;
    toast(prog.textContent, 4000);
  } finally {
    exportBusy = false;
    controls.forEach((control, i) => control.disabled = disabled[i]);
    $('#btn-do-export').textContent = 'Export';
    if (state.project === proj) setWorkspaceBusy(false);
  }
};
