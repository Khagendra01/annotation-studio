'use strict';

// Pure filtering: stable breadth-first order, strict limits, no source mutation.
// Usable from classic scripts (including file://) and Node tests.
(function (root) {
  function normalize(caps = {}) {
    const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    return { depth: positive(caps.depth), total: positive(caps.total) };
  }
  function select(rows, get, caps = {}, remaining = Infinity) {
    const { depth } = normalize(caps);
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
      const post = get('role', row) === 'op';
      if (!post && ((depth && level > depth) || comments >= remaining)) continue;
      selected.add(id);
      if (!post) comments++;
      for (const child of children.get(id) || []) queue.push([child, level + 1]);
    }
    return { rows: [...byId.values()].filter(row => selected.has(get('node_id', row))), comments };
  }
  const api = { normalize, select };
  root.AnnotationScope = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
