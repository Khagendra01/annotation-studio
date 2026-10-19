const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, select } = require('../annotator/scope.js');
const get = (key, row) => row[key] || '';
const row = (id, parent, role = 'comment') => ({ node_id: id, parent_id: parent, role, created_utc: id });
const rows = [row('post', '', 'op'), row('a', 'post'), row('b', 'a', 'target'), row('c', 'post'), row('d', 'b')];
const ids = result => result.rows.map(row => row.node_id);

test('old per-thread cap is discarded without losing the remaining filters', () => {
  assert.deepEqual(normalize({ comments: 1, depth: 2, total: 7 }), { depth: 2, total: 7 });
  assert.deepEqual(normalize({ depth: -1, total: 1.5 }), { depth: 0, total: 0 });
});
test('depth one keeps direct replies and strictly excludes deeper targets', () => {
  assert.deepEqual(ids(select(rows, get, { depth: 1 })), ['post', 'a', 'c']);
  assert.deepEqual(ids(select(rows, get, { depth: 2 })), ['post', 'a', 'b', 'c']);
});
test('the per-thread cap trims a large thread at the tail', () => {
  const result = select(rows, get, { total: 2 });
  assert.deepEqual(ids(result), ['post', 'a', 'c']);
  assert.equal(result.comments, 2);
});
test('every thread receives the full cap independently', () => {
  const first = select(rows, get, { depth: 1, total: 1 });
  assert.deepEqual(ids(first), ['post', 'a']);
  assert.equal(first.comments, 1);
  const second = select([row('p2', '', 'op'), row('e', 'p2'), row('f', 'p2')], get, { depth: 1, total: 1 });
  assert.equal(second.comments, 1, 'a spent cap in thread 1 must not shrink thread 2');
  assert.deepEqual(ids(second), ['p2', 'e']);
});
test('duplicate rows count once, posts do not count, and source is unchanged', () => {
  const snapshot = JSON.stringify(rows);
  const result = select([...rows, rows[1]], get, {});
  assert.equal(result.comments, 4);
  assert.equal(result.rows.length, 5);
  assert.equal(JSON.stringify(rows), snapshot);
  assert.deepEqual(ids(select(rows, get, { total: 1 })), ['post', 'a']);
});
test('missing parent is treated as a direct reply; cycles cannot hang filtering', () => {
  assert.deepEqual(ids(select([row('a', 'missing'), row('b', 'a')], get, { depth: 1 })), ['a']);
  assert.deepEqual(ids(select([row('a', 'b'), row('b', 'a')], get, {})), []);
});
test('exempt targets survive the depth limit together with their reply chain', () => {
  const result = select(rows, get, { depth: 1 }, new Set(['b']));
  assert.deepEqual(ids(result), ['post', 'a', 'b', 'c']);
  assert.equal(result.comments, 1);
});
test('exempt targets survive the per-thread cap and never count toward it', () => {
  const capped = select(rows, get, { depth: 1, total: 1 }, new Set(['b']));
  assert.deepEqual(ids(capped), ['post', 'a', 'b', 'c']);
  assert.equal(capped.comments, 1, 'the cap is spent on context, never on the exempt chain');
  const deep = select(rows, get, { total: 1 }, new Set(['b']));
  assert.deepEqual(ids(deep), ['post', 'a', 'b', 'c']);
  assert.equal(deep.comments, 1);
});
test('exempt ids outside the dataset are ignored without breaking limits', () => {
  assert.deepEqual(ids(select(rows, get, { depth: 1, total: 1 }, new Set(['nope']))), ['post', 'a']);
});
