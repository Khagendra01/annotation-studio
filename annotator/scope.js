'use strict';

// Pure filtering: stable breadth-first order, no source mutation.
// `caps.total` caps each thread independently — it is re-read on every call,
// so no thread ever spends another thread's allowance.
// Exempt ids (relabel targets) survive depth and cap limits together with
// their ancestor chain, and never count toward the cap.
// Usable from classic scripts (including file://) and Node tests.
(function (root) {
  function normalize(caps = {}) {
    const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    return { depth: positive(caps.depth), total: positive(caps.total) };
  }
  function select(rows, get, caps = {}, keep = null) {
    const { depth, total } = normalize(caps);
    const budget = total || Infinity;
    const byId = new Map(rows.map(row => [get('node_id', row), row]));
    const children = new Map(), roots = [];
    for (const row of byId.values()) {
      const parent = get('parent_id', row);
      if (!parent || !byId.has(parent)) roots.push(row);
      else {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(row);
      }
    }
    const exempt = new Set();
    for (const id of keep || []) {
      let cur = id, guard = 0;
      while (byId.has(cur) && guard++ < 1000) {
        if (exempt.has(cur)) break;
        exempt.add(cur);
        cur = get('parent_id', byId.get(cur)) || '';
      }
    }
    const compare = (a, b) => String(get('created_utc', a)).localeCompare(String(get('created_utc', b))) ||
      String(get('node_id', a)).localeCompare(String(get('node_id', b)));
    roots.sort(compare);
    for (const values of children.values()) values.sort(compare);
    const queue = roots.map(row => [row, get('role', row) === 'op' ? 0 : 1]);
    const selected = new Set(), visited = new Set();
    let comments = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [row, level] = queue[cursor], id = get('node_id', row);
      if (visited.has(id)) continue;
      visited.add(id);
      const post = get('role', row) === 'op', free = post || exempt.has(id);
      if (!free && ((depth && level > depth) || comments >= budget)) continue;
      selected.add(id);
      if (!free) comments++;
      for (const child of children.get(id) || []) queue.push([child, level + 1]);
    }
    return { rows: [...byId.values()].filter(row => selected.has(get('node_id', row))), comments };
  }
  const api = { normalize, select };
  root.AnnotationScope = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
