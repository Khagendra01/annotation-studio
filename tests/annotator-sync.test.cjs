const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

function setup(storage = new MemoryStorage(), database = { projects: [], annotations: [], positions: [] }) {
  let user = { id: 'account-a' }, nextId = 1;
  let beforeRequest = async () => {};
  const status = { classList: { toggle() {} }, addEventListener() {} };
  const timers = new Map();
  class Query {
    constructor(table) { this.table = table; this.uid = user.id; this.filters = []; }
    select() { return this; }
    order(key) { this.sort = key; return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    range(from, to) { this.bounds = [from, to]; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    upsert(rows) { this.writes = Array.isArray(rows) ? rows : [rows]; return this; }
    delete() { this.deleting = true; return this; }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      await beforeRequest(this);
      let rows = database[this.table];
      const owned = row => this.table === 'projects' ? row.owner_id === this.uid
        : database.projects.some(project => project.id === row.project_id && project.owner_id === this.uid);
      const matches = row => owned(row) && this.filters.every(filter => filter(row));
      if (this.writes) {
        const result = [];
        for (const source of this.writes) {
          const keys = this.table === 'projects' ? ['owner_id', 'name']
            : this.table === 'annotations' ? ['project_id', 'node_id', 'reviewer_id'] : ['project_id', 'reviewer_id'];
          const existing = rows.find(row => keys.every(key => row[key] === source[key]));
          const row = existing || (this.table === 'projects' ? { id: 'project-' + nextId++ } : {});
          Object.assign(row, structuredClone(source));
          if (!owned(row)) throw new Error('mock RLS rejected write');
          if (!existing) rows.push(row);
          result.push(row);
        }
        return { data: this.one ? result[0] : result, error: null };
      }
      if (this.deleting) {
        const deleted = rows.filter(matches);
        database[this.table] = rows.filter(row => !matches(row));
        if (this.table === 'projects') {
          for (const table of ['annotations', 'positions']) {
            database[table] = database[table].filter(row => !deleted.some(project => project.id === row.project_id));
          }
        }
        return { data: [], error: null };
      }
      rows = rows.filter(matches);
      if (this.sort) rows.sort((a, b) => String(a[this.sort]).localeCompare(String(b[this.sort])));
      if (this.bounds) rows = rows.slice(this.bounds[0], this.bounds[1] + 1);
      return { data: structuredClone(this.one ? rows[0] || null : rows), error: null };
    }
  }
  const context = vm.createContext({
    console: { error() {} }, localStorage: storage,
    setTimeout(fn) { const key = Symbol(); timers.set(key, fn); return key; },
    clearTimeout(key) { timers.delete(key); },
    addEventListener() {},
    document: { addEventListener() {}, getElementById(id) { return id === 'st-sync' ? status : null; } },
    AuthGate: { isConfigured: () => true, user: () => user, client: () => ({ from: table => new Query(table) }) },
  });
  context.window = context;
  for (const file of ['repository.js', 'sync.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../annotator', file), 'utf8'), context, { filename: file });
  }
  return {
    storage, database, status, context,
    repo: new context.AnnotationRepository(), sync: context.RemoteSync,
    as(id) { user = { id }; }, intercept(fn) { beforeRequest = fn; },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
  };
}

const projectsKey = 'annotator.projects.v1';
const labelsKey = 'annotator.labels.v1.Research';
const list = value => JSON.parse(JSON.stringify(value));

test('legacy work is retained without copying and projects, labels, and imports stay isolated between accounts', async () => {
  const app = setup();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  app.repo.set(labelsKey, { target: { label: 'caution_and_advice', rev: true, taskId: 1 } });
  app.repo.set('annotator.data.v1.Research', { columns: ['text'], rows: [['private source']] });
  await app.sync.signIn();
  assert.equal(app.database.annotations.length, 1);
  app.sync.signOut();
  app.as('account-b');
  await app.sync.signIn();
  assert.deepEqual(list(app.repo.get(projectsKey, [])), []);
  assert.deepEqual(list(app.repo.get(labelsKey, {})), {});
  assert.equal(app.repo.get('annotator.data.v1.Research'), null);
  assert.ok(app.database.projects.every(project => project.owner_id === 'account-a'));
  app.sync.signOut();
  app.as('account-a');
  await app.sync.signIn();
  assert.equal(app.repo.get(labelsKey).target.label, 'caution_and_advice');
  app.repo.remove('annotator.data.v1.Research');
  app.sync.signOut();
  await app.sync.signIn();
  assert.equal(app.repo.get('annotator.data.v1.Research'), null, 'account changes must not resurrect deleted imports');
});

test('explicit label clears survive synchronization and a new browser session', async () => {
  const app = setup();
  await app.sync.signIn();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  app.repo.set(labelsKey, { target: { label: 'caution_and_advice', rev: true, taskId: 1 } });
  await app.sync.syncNow();
  assert.equal(app.database.annotations[0].label, 'caution_and_advice');
  app.repo.set(labelsKey, { target: { label: '', rev: false, taskId: 1 } });
  await app.sync.syncNow();
  assert.equal(app.database.annotations[0].label, '');
  assert.equal(app.database.annotations[0].reviewed, false);
  app.sync.signOut();
  const fresh = setup(new MemoryStorage(), app.database);
  await fresh.sync.signIn();
  assert.equal(fresh.repo.get(labelsKey).target.label, '');
  assert.equal(fresh.repo.get(labelsKey).target.rev, false);
  const seededStorage = new MemoryStorage();
  seededStorage.setItem(projectsKey, JSON.stringify([{ name: 'Research', skeleton: true }]));
  seededStorage.setItem(labelsKey, JSON.stringify({ target: { label: 'source_label', taskId: 1 } }));
  const seeded = setup(seededStorage, app.database);
  await seeded.sync.signIn();
  assert.equal(seeded.repo.get(labelsKey).target.label, '', 'a source-seeded local label cannot override a cloud clear');
});

test('deleting a project survives pull-before-push and preserves unrelated remote projects', async () => {
  const app = setup();
  await app.sync.signIn();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  await app.sync.syncNow();
  app.database.projects.push({ id: 'other-device', owner_id: 'account-a', name: 'Other device', meta: {}, caps: {} });
  app.repo.set('annotator.deleted-projects.v1', ['Research']);
  app.repo.set(projectsKey, []);
  await app.sync.syncNow();
  assert.deepEqual(app.database.projects.map(project => project.name), ['Other device']);
  assert.deepEqual(list(app.repo.get(projectsKey)).map(project => project.name), ['Other device']);
});

test('an old account response cannot hydrate or upload into a newly signed-in account', async () => {
  const app = setup();
  await app.sync.signIn();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  await app.sync.syncNow();
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  app.intercept(async query => {
    if (query.uid === 'account-a' && query.table === 'projects' && !query.writes) {
      reached(); await pending;
    }
  });
  const oldRequest = app.sync.syncNow();
  await waiting;
  app.sync.signOut();
  app.as('account-b');
  await app.sync.signIn();
  release();
  await oldRequest;
  assert.deepEqual(list(app.repo.get(projectsKey, [])), []);
  assert.ok(app.database.projects.every(project => project.owner_id === 'account-a'));
});

test('pending label and position timers cannot recreate a project deleted before its first sync', async () => {
  const app = setup();
  await app.sync.signIn();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  app.repo.set(labelsKey, { target: { label: 'caution_and_advice', rev: true, taskId: 1 } });
  app.repo.set('annotator.pos.v1.Research', 1);
  app.repo.set('annotator.deleted-projects.v1', ['Research']);
  app.repo.set(projectsKey, []);
  app.repo.remove(labelsKey);
  app.flushTimers();
  await app.sync.syncNow();
  assert.deepEqual(app.database.projects, []);
});

test('failed sync retains the local edit and retries it on the next sync', async () => {
  const app = setup();
  await app.sync.signIn();
  app.repo.set(projectsKey, [{ name: 'Research', skeleton: true }]);
  app.repo.set(labelsKey, { target: { label: 'caution_and_advice', rev: true, taskId: 1 } });
  app.intercept(async query => { if (query.table === 'annotations' && query.writes) throw new Error('offline'); });
  await app.sync.syncNow();
  assert.match(app.status.textContent, /sync error/);
  assert.equal(app.repo.get(labelsKey).target.label, 'caution_and_advice');
  app.intercept(async () => {});
  await app.sync.syncNow();
  assert.equal(app.database.annotations[0].label, 'caution_and_advice');
  assert.match(app.status.textContent, /synced/);
});
