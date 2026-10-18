'use strict';
/* ============================ view modal ============================ */
function collectViewRows() {
  const proj = state.project;
  const scope = $('#v-scope').value;
  const rows = [];
  if (scope === 'labeled') {
    for (const [id, entry] of Object.entries(state.labels)) {
      const r = entry.row;
      if (!r) continue;
      rows.push(r);
    }
    // labeled rows lacking a stored row (shouldn't happen) — skip
  } else {
    for (const t of proj.tasks) {
      if (t.rawRows) rows.push(...t.rawRows);
    }
  }
  return rows;
}

function applyViewFilters() {
  const proj = state.project;
  const lab = $('#v-label').value;
  const role = $('#v-role').value;
  const taskQ = $('#v-task').value.trim().toLowerCase();
  const txtQ = $('#v-text').value.toLowerCase();
  let rows = collectViewRows();
  rows = rows.filter(r => {
    const id = col(proj, 'node_id', r);
    const l = state.labels[id]?.label || col(proj, 'label', r) || '';
    const ro = col(proj, 'role', r);
    const ti = col(proj, 'task_index', r);
    const tx = col(proj, 'text', r);
    if (lab && l !== lab) return false;
    if (role && ro !== role) return false;
    if (taskQ && !String(ti).toLowerCase().includes(taskQ) && !id.toLowerCase().includes(taskQ)) return false;
    if (txtQ && !tx.toLowerCase().includes(txtQ)) return false;
    return true;
  });
  const sortKey = applyViewFilters.sort || 'task';
  const dir = applyViewFilters.dir || 1;
  const get = r => ({
    task: +col(proj, 'task_index', r) || 0,
    id: col(proj, 'node_id', r),
    parent: col(proj, 'parent_id', r),
    role: col(proj, 'role', r),
    label: state.labels[col(proj, 'node_id', r)]?.label || col(proj, 'label', r) || '',
    created: col(proj, 'created_utc', r),
    text: col(proj, 'text', r),
  })[sortKey];
  rows.sort((a, b) => {
    const x = get(a), y = get(b);
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
  return rows;
}

function renderViewTable() {
  const proj = state.project;
  const rows = applyViewFilters();
  const limit = renderViewTable.limit = Math.max(100, Math.min(renderViewTable.limit || 200, 5000));
  const shown = rows.slice(0, limit);
  $('#v-body').innerHTML = shown.map(r => {
    const id = col(proj, 'node_id', r);
    const label = state.labels[id]?.label || col(proj, 'label', r) || '';
    return `<tr>
      <td>${esc(col(proj, 'task_index', r))}</td>
      <td><code>${esc(id)}</code></td>
      <td><code>${esc(col(proj, 'parent_id', r))}</code></td>
      <td>${esc(col(proj, 'role', r))}</td>
      <td>${label ? `<span class="chip set">${esc(label)}</span>` : ''}</td>
      <td>${esc(col(proj, 'created_utc', r))}</td>
      <td class="txt" title="${esc(col(proj, 'text', r))}">${esc(col(proj, 'text', r)).slice(0, 160)}</td>
    </tr>`;
  }).join('');
  $('#v-count').textContent = `${rows.length.toLocaleString()} rows`;
  $('#v-pageinfo').textContent = `showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`;
  $('#v-more').disabled = shown.length >= rows.length;
  $('#v-more').textContent = shown.length >= rows.length ? 'All shown' : `Show next ${Math.min(500, rows.length - shown.length)}`;
}

async function openViewModal() {
  if (!state.project) return;
  const sel = $('#v-label');
  sel.innerHTML = '<option value="">(any)</option>' +
    HUMAID.map(([v]) => `<option value="${v}">${v}</option>`).join('');
  renderViewTable.limit = 200;
  $('#view-modal').hidden = false;
  renderViewTable();
}
$('#btn-view').onclick = openViewModal;
['v-scope', 'v-label', 'v-role'].forEach(id => $('#' + id).onchange = () => { renderViewTable.limit = 200; renderViewTable(); });
['v-task', 'v-text'].forEach(id => $('#' + id).oninput = () => { renderViewTable.limit = 200; renderViewTable(); });
$('#v-more').onclick = () => { renderViewTable.limit += 500; renderViewTable(); };
$$('table.view th[data-sort]').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  if (applyViewFilters.sort === k) applyViewFilters.dir *= -1;
  else { applyViewFilters.sort = k; applyViewFilters.dir = 1; }
  renderViewTable();
});

