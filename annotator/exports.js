'use strict';
/* ============================ export modal ============================ */
$('#btn-export').onclick = () => {
  if (!state.project) return;
  const n = Object.keys(state.labels).length;
  $('#export-progress').textContent = `${n} labeled node${n === 1 ? '' : 's'} in “${state.project.name}”`;
  $('#export-modal').hidden = false;
};

async function loadAllChunks() {
  const proj = state.project;
  if (!proj.dataDir) return;
  const total = proj.chunked.chunks.length;
  for (let c = 1; c <= total; c++) {
    if (attachChunkRows(proj, c)) continue;
    $('#export-progress').textContent = `loading chunk ${c}/${total}…`;
    await injectScript(`data_annotated/${proj.dataDir}/c${String(c).padStart(2, '0')}.js`);
    attachChunkRows(proj, c);
  }
}

function taskRows(proj) {
  const rows = [];
  proj.tasks.forEach((task, i) => (task.rawRows || task.rows || []).forEach(row => {
    const id = col(proj, 'node_id', row);
    rows.push({ taskId: task.i ?? i, task, row, id, label: state.labels[id]?.label ?? col(proj, 'label', row) ?? '' });
  }));
  return rows;
}

function effectiveLabel(entry) {
  return state.labels[entry.id]?.label ?? entry.label ?? '';
}

function sourceObject(proj, entry, schema) {
  const obj = {};
  if (schema === 'node') obj.task_index = entry.taskId;
  proj.columns.forEach((name, i) => {
    obj[name] = name === 'label' ? effectiveLabel(entry) : (entry.row[i] ?? '');
  });
  if (proj.colIdx.label === undefined) obj.label = effectiveLabel(entry);
  return obj;
}

function fiveHundredEntries(proj) {
  return proj.tasks.map((task, i) => ({ task, taskId: task.i ?? i }))
    .filter(x => x.task.target && (x.task.oldLabel !== undefined || x.task.unrecovered))
    .sort((a, b) => (a.task.sourceRow || 1e9) - (b.task.sourceRow || 1e9))
    .map(({ task, taskId }) => {
      const id = task.target;
      const row = task.rawRows?.find(r => col(proj, 'node_id', r) === id) || task.rows?.find(r => col(proj, 'node_id', r)) || [];
      const originalText = task.unrecovered ? (task.rawRows?.[0]?.[proj.colIdx.text] ?? '') : (task.targetText || col(proj, 'text', row) || '');
      return { task, taskId, row, id, label: state.labels[id]?.label ?? task.oldLabel ?? '', postId: task.unrecovered || task.postId || id.replace(/^t[13]_/, ''), text: originalText };
    });
}

function treePath(proj, entry) {
  const rows = entry.task.rawRows || entry.task.rows || [];
  const byId = new Map(rows.map(row => [col(proj, 'node_id', row), row]));
  const path = [];
  let row = byId.get(entry.id), guard = 0;
  while (row && guard++ < 500) {
    path.unshift({ node_id: col(proj, 'node_id', row) || '', role: col(proj, 'role', row) || '', text: col(proj, 'text', row) || '' });
    const parent = col(proj, 'parent_id', row);
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
  const proj = state.project;
  const format = $('input[name="exp-format"]:checked').value;
  const scope = $('input[name="exp-scope"]:checked').value;
  const schema = $('input[name="exp-schema"]:checked').value;
  const prog = $('#export-progress');
  try {
    await loadAllChunks();
    const all = taskRows(proj);
    let objects;
    let filename = proj.name;
    if (schema === '500' || schema === 'tree') {
      objects = fiveHundredEntries(proj).filter(e => scope === 'full' || effectiveLabel(e) !== '').map(e => schema === '500'
        ? { post_id: e.postId, post_text: e.text, class_label: effectiveLabel(e) }
        : { post_id: e.postId, tree_path: treePath(proj, e), class_label: effectiveLabel(e) });
      filename += schema === '500' ? '-relabelled-500' : '-relabelled-500-tree-path';
    } else {
      const selected = scope === 'labeled' ? all.filter(e => effectiveLabel(e) !== '') : all;
      objects = selected.map(e => sourceObject(proj, e, schema));
      filename += scope === 'labeled' ? '-labeled' : '-full';
      filename += schema === 'node' ? '-threads' : '-original';
    }

    if (!objects.length) throw new Error(scope === 'labeled' ? 'No labeled rows to export.' : 'This project has no exportable rows.');
    if (format === 'json') {
      download(`${filename}.json`, 'application/json', JSON.stringify(objects, null, 2));
    } else {
      const headers = schema === '500' ? ['post_id', 'post_text', 'class_label']
        : schema === 'tree' ? ['post_id', 'tree_path', 'class_label'] : Object.keys(objects[0]);
      const csvObjects = schema === 'tree' ? objects.map(o => ({ ...o, tree_path: JSON.stringify(o.tree_path) })) : objects;
      download(`${filename}.csv`, 'text/csv', asCsv(headers, csvObjects));
    }
    prog.textContent = '';
    toast(`Exported ${objects.length.toLocaleString()} rows as ${format.toUpperCase()}.`, 4000);
    $('#export-modal').hidden = true;
  } catch (e) {
    console.error(e);
    prog.textContent = '';
    toast('Export failed: ' + e.message, 4000);
  }
};
