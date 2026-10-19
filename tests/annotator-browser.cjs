// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package when
// it is not available through Node's normal module resolution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const configPath = path.resolve(__dirname, '../annotator/config.js');
const configBackup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
function restoreConfig() {
  if (configBackup === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, configBackup);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

(async () => {
  // This suite exercises the local-only annotator. A machine with a configured
  // Supabase install would stop at the sign-in gate — that path is annotator-auth.cjs.
  fs.writeFileSync(configPath, '// test fixture — restored automatically\nwindow.SUPABASE_CONFIG = null;\n');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = pathToFileURL(path.resolve(__dirname, '../annotator.html')).href;
    await page.goto(url);
    assert.equal(await page.locator('#cap-comments').count(), 0);
    assert.equal(await page.locator('#newproj-form input[type=number]').count(), 2);
    assert.equal(await page.locator('[data-filter-preview]').count(), 0);
    assert.equal(await page.getByText('SEE HOW IT WORKS').count(), 0);
    await page.screenshot({ path: '/tmp/annotator-home.png' });
    await page.locator('#newproj-name').fill('Browser verification');
    await page.locator('#cap-depth').fill('1');
    await page.locator('#cap-total').fill('8');
    await page.locator('#btn-create').click();
    await page.waitForFunction(() => !state.busy && state.viewById?.size > 1);
    const queueTotal = await page.locator('#queue-count').textContent();
    assert.equal(queueTotal, String(await page.evaluate(() => state.project.threadGroup.size)), 'per-thread cap blocks no thread');
    const firstCount = await page.locator('#thread .c').count();
    assert.ok(firstCount > 1 && firstCount <= 9);
    assert.equal(await page.evaluate(() => [...state.viewById.values()].filter(r => col(state.project, 'role', r) !== 'op').every(r => col(state.project, 'parent_id', r) === state.project.tasks[state.taskIdx].root)), true);
    assert.match(await page.locator('#scope-summary').textContent(), /≤ 8 comments per post/);
    const firstId = await page.locator('.labelctl').first().getAttribute('data-node');
    await page.locator('.label-select').first().selectOption('sympathy_and_support');
    await page.waitForFunction(() => document.querySelector('#st-storage').textContent.includes('autosaved'));
    await page.screenshot({ path: '/tmp/annotator-workspace.png' });

    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator('#btn-settings').click();
    assert.equal(await page.locator('#settings-modal input[type=number]').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#btn-apply-settings').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }), true, 'Filters Apply button stays visible on a small screen');
    await page.locator('#set-depth').fill('2');
    await page.locator('#set-total').fill('12');
    await page.locator('#btn-apply-settings').click();
    await page.waitForFunction(() => !state.busy && state.project.caps.total === 12);
    const updatedCount = await page.locator('#thread .c').count();
    assert.ok(updatedCount > 1 && updatedCount <= 13);
    assert.match(await page.locator('#scope-summary').textContent(), /≤ 12 comments per post/);
    await page.reload();
    await page.waitForFunction(() => !state.busy && state.viewById?.size > 1 && state.project?.caps.total === 12);
    assert.equal(await page.locator('#thread .c').count(), updatedCount);
    assert.equal(await page.evaluate(id => state.labels[id].label, firstId), 'sympathy_and_support');
    assert.equal(await page.evaluate(() => state.project.caps.depth), 2);
    await page.locator('#btn-view').click();
    await page.locator('#v-text').fill('zz-no-match-zz');
    assert.equal(await page.locator('#v-body tr').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#v-more').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }), true, 'Review modal footer stays visible on a small screen');
    await page.keyboard.press('Escape');

    await page.locator('#btn-export').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.match(await page.locator('#export-progress').textContent(), /1 saved label/);
    assert.equal(await page.locator('#btn-do-export').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }), true, 'Export button stays visible without zooming');
    const schemaSamples = [
      ['original', 'Original project columns', ['task_index', 'thread_id', 'node_id', 'parent_id', 'role', 'created_utc', 'state', 'replies', 'is_target', 'text', 'label']],
      ['node', 'Thread rows', ['task_index', 'node_id', 'parent_id', 'role', 'label', 'text', 'thread_id', 'created_utc', 'state', 'replies', 'is_target']],
      ['500', 'Relabeled 500 format', ['post_id', 'post_text', 'class_label']],
      ['tree', 'Target with full tree path', ['post_id', 'tree_path', 'class_label']],
    ];
    for (const [schema, title, expectedHeaders] of schemaSamples) {
      await page.locator(`input[name="exp-schema"][value="${schema}"]`).check();
      assert.equal(await page.locator('#export-sample-name').textContent(), title);
      assert.deepEqual(await page.locator('#export-sample-table thead th').allTextContents(), expectedHeaders);
      assert.equal(await page.locator('#export-sample-table tbody tr').count(), 1);
    }
    assert.match(await page.locator('#export-sample-table tbody').textContent(), /t3_1hwabc/);
    const downloadDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'annotator-exports-'));
    const liveTreeFiles = {};
    for (const format of ['json', 'csv']) {
      await page.locator('input[name="exp-format"][value="' + format + '"]').check();
      await page.locator('input[name="exp-scope"][value="full"]').check();
      await page.locator('input[name="exp-schema"][value="tree"]').check();
      const pending = page.waitForEvent('download');
      await page.locator('#btn-do-export').click();
      const download = await pending;
      const file = path.join(downloadDir, `actual-tree-full.${format}`);
      await download.saveAs(file);
      const raw = fs.readFileSync(file, 'utf8');
      const records = format === 'json' ? JSON.parse(raw) : (() => {
        const [headers, ...rows] = parseCsv(raw);
        return rows.map(row => Object.fromEntries(headers.map((key, i) => [key,
          key === 'tree_path' ? JSON.parse(row[i]) : row[i]])));
      })();
      assert.ok(records.length > 0, `real full tree ${format} export is not empty`);
      assert.deepEqual(Object.keys(records[0]), ['post_id', 'tree_path', 'class_label']);
      for (const record of records) {
        assert.ok(Array.isArray(record.tree_path) && record.tree_path.length > 0, 'real export has a path for each target');
        assert.ok(record.tree_path.every(node => node.node_id && typeof node.text === 'string'));
        assert.equal(record.post_id, record.tree_path.at(-1).node_id.replace(/^t[13]_/, ''));
      }
      assert.ok(records.some(record => record.tree_path.length > 1), 'real tree paths include ancestor rows, not only target text');
      console.log(`Verified actual full-tree ${format}: ${records.length} targets; ${records.filter(record => record.tree_path.length > 1).length} include ancestors`);
      liveTreeFiles[format] = records.map(record => ({ ...record,
        post_id: String(record.post_id), class_label: String(record.class_label ?? ''),
      }));
      await page.locator('#btn-export').click();
    }
    assert.deepEqual(liveTreeFiles.csv, liveTreeFiles.json, 'real full-tree CSV and JSON exports should agree');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      await openSkeletonProject('Temporary Relabel Export Verification', null, 'point', 'relabel');
      const target = state.project.tasks.find(task => task.target);
      const row = target.rawRows?.find(item => col(state.project, 'node_id', item) === target.target) || [];
      state.labels[target.target] = { label: 'requests_or_urgent_needs', taskId: target.i, row, rev: true };
    });
    console.log('Relabel export label counts:', await page.evaluate(() => ({
      saved: Object.values(state.labels).filter(entry => entry?.rev).length,
      targetSourceLabels: state.project.tasks.filter(task => task.target && task.oldLabel).length,
      targets: state.project.tasks.filter(task => task.target).length,
    })));
    await page.locator('#btn-export').click();
    const relabelTreeFiles = {};
    for (const format of ['json', 'csv']) {
      await page.locator(`input[name="exp-format"][value="${format}"]`).check();
      await page.locator('input[name="exp-scope"][value="full"]').check();
      await page.locator('input[name="exp-schema"][value="tree"]').check();
      const pending = page.waitForEvent('download');
      await page.locator('#btn-do-export').click();
      const download = await pending;
      const file = path.join(downloadDir, `relabel-500-tree.${format}`);
      await download.saveAs(file);
      const raw = fs.readFileSync(file, 'utf8');
      relabelTreeFiles[format] = format === 'json' ? JSON.parse(raw) : (() => {
        const [headers, ...rows] = parseCsv(raw);
        return rows.map(row => Object.fromEntries(headers.map((key, i) => [key,
          key === 'tree_path' ? JSON.parse(row[i]) : row[i]])));
      })();
      assert.equal(relabelTreeFiles[format].length, 500, `Relabel-500 ${format} export has all 500 targets`);
      assert.ok(relabelTreeFiles[format].every(record => record.tree_path.length > 0));
      assert.ok(relabelTreeFiles[format].some(record => record.tree_path.length > 1), 'recovered targets include ancestors');
      assert.ok(relabelTreeFiles[format].some(record => record.tree_path.length === 1), 'unrecovered posts retain their standalone post text');
      for (const record of relabelTreeFiles[format]) {
        assert.ok(record.tree_path.every(node => node.node_id && typeof node.text === 'string'));
        assert.equal(String(record.post_id), String(record.tree_path.at(-1).node_id).replace(/^t[13]_/, ''));
      }
      console.log(`Verified Relabel-500 tree ${format}: 500 target rows, including ancestor paths and standalone unrecovered posts`);
      await page.locator('#btn-export').click();
    }
    assert.deepEqual(relabelTreeFiles.csv, relabelTreeFiles.json, 'Relabel-500 tree CSV and JSON should agree');
    await page.locator('input[name="exp-format"][value="csv"]').check();
    await page.locator('input[name="exp-scope"][value="labeled"]').check();
    await page.locator('input[name="exp-schema"][value="tree"]').check();
    const labeledTreeDownload = page.waitForEvent('download');
    await page.locator('#btn-do-export').click();
    const labeledTreeFile = await labeledTreeDownload;
    const labeledTreePath = path.join(downloadDir, 'relabel-500-labeled-tree.csv');
    await labeledTreeFile.saveAs(labeledTreePath);
    const [, ...labeledTreeRows] = parseCsv(fs.readFileSync(labeledTreePath, 'utf8'));
    assert.equal(labeledTreeRows.length, 1, 'labeled-only tree export excludes source-labeled targets');
    await page.locator('#btn-export').click();
    await page.evaluate(() => {
      const columns = ['task_index', 'thread_id', 'node_id', 'parent_id', 'role', 'created_utc', 'state', 'replies', 'is_target', 'text', 'label'];
      const row = (task, id, parent, role, text) => [String(task), 'sample', id, parent, role, '2025-01-01', 'present', '1', role === 'target' ? '1' : '0', text, ''];
      const tasks = ['a', 'b'].map((suffix, i) => ({
        i: i + 1, threadId: 'sample', target: `t1_target_${suffix}`, oldLabel: 'caution_and_advice', postId: `target_${suffix}`,
        targetText: `${suffix === 'a' ? 'First' : 'Second'} leaf target text`,
        rawRows: [
          row(i + 1, 't3_post', '', 'op', 'Root post text'),
          row(i + 1, 't1_comment', 't3_post', 'comment', 'Ancestor "comment", text\r\nsecond line 🌲'),
          row(i + 1, 't1_target_a', 't1_comment', suffix === 'a' ? 'target' : 'comment', 'First leaf target text'),
          row(i + 1, 't1_target_b', 't1_comment', suffix === 'b' ? 'target' : 'comment', 'Second leaf target text'),
        ],
      }));
      state.project = { name: 'Export fixture', columns, colIdx: Object.fromEntries(columns.map((key, i) => [key, i])), tasks,
        threadGroup: new Map([['sample', tasks]]), caps: {} };
      state.taskIdx = 0;
      state.labels = { t1_target_a: { label: 'requests_or_urgent_needs', taskId: 1, row: tasks[0].rawRows[2], rev: true } };
    });
    const combinations = new Map();
    for (const format of ['csv', 'json']) {
      for (const scope of ['labeled', 'full']) {
        for (const schema of ['original', 'node', '500', 'tree']) {
          await page.locator(`input[name="exp-format"][value="${format}"]`).check();
          await page.locator(`input[name="exp-scope"][value="${scope}"]`).check();
          await page.locator(`input[name="exp-schema"][value="${schema}"]`).check();
          const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
          await page.locator('#btn-do-export').click();
          const download = await downloadPromise;
          assert.match(download.suggestedFilename(), new RegExp(`\\.${format}$`));
          const file = path.join(downloadDir, download.suggestedFilename());
          await download.saveAs(file);
          const raw = fs.readFileSync(file, 'utf8');
          const objects = format === 'json'
            ? JSON.parse(raw).map(object => Object.fromEntries(Object.entries(object).map(([key, value]) =>
              [key, schema === 'tree' && key === 'tree_path' ? value : String(value ?? '')])))
            : (() => {
              const [headers, ...rows] = parseCsv(raw);
              return rows.map(row => Object.fromEntries(headers.map((key, i) => [key,
                schema === 'tree' && key === 'tree_path' ? JSON.parse(row[i]) : row[i]])));
            })();
          assert.ok(objects.length > 0, `${format}/${scope}/${schema} must contain rows`);
          const expectedHeaders = schema === 'tree' ? ['post_id', 'tree_path', 'class_label']
            : schema === '500' ? ['post_id', 'post_text', 'class_label']
              : schema === 'node' ? schemaSamples[1][2] : schemaSamples[0][2];
          assert.deepEqual(Object.keys(objects[0]), expectedHeaders, `${format}/${scope}/${schema} headers`);
          if (schema === 'tree') {
            for (const object of objects) {
              assert.ok(Array.isArray(object.tree_path) && object.tree_path.length > 0,
                `${format}/${scope} tree path must be a non-empty structured array`);
              assert.ok(object.tree_path.every(node => node.node_id && typeof node.text === 'string'),
                `${format}/${scope} path nodes must preserve IDs and text`);
              assert.match(object.tree_path.at(-1).role, /target/i,
                `${format}/${scope} path must end at its labeled target`);
              assert.equal(object.post_id, object.tree_path.at(-1).node_id.replace(/^t[13]_/, ''));
              assert.deepEqual(object.tree_path.map(node => node.text), [
                'Root post text', 'Ancestor "comment", text\r\nsecond line 🌲', `${object.post_id === 'target_a' ? 'First' : 'Second'} leaf target text`,
              ]);
            }
          }
          const expectedCount = ['500', 'tree'].includes(schema)
            ? (scope === 'labeled' ? 1 : 2)
            : (scope === 'labeled' ? 1 : schema === 'node' ? 4 : 8);
          assert.equal(objects.length, expectedCount, `${format}/${scope}/${schema} must honor its scope`);
          combinations.set(`${scope}/${schema}/${format}`, objects);
          await page.locator('#btn-export').click();
        }
      }
    }
    for (const scope of ['labeled', 'full']) for (const schema of ['original', 'node', '500', 'tree']) {
      assert.deepEqual(combinations.get(`${scope}/${schema}/csv`), combinations.get(`${scope}/${schema}/json`),
        `${scope}/${schema} CSV and JSON rows should represent identical data`);
    }
    fs.rmSync(downloadDir, { recursive: true, force: true });
    await page.keyboard.press('Escape');
    const pathChecks = await page.evaluate(() => {
      const proj = state.project;
      const make = (id, parent) => proj.columns.map(key => ({ node_id: id, parent_id: parent, role: 'comment', text: id })[key] ?? '');
      const cyclic = { id: 'x', task: { rawRows: [make('x', 'y'), make('y', 'x')] } };
      const missing = { id: 'x', task: { rawRows: [make('x', 'missing')] } };
      const error = entry => { try { treePath(proj, entry); return ''; } catch (error) { return error.message; } };
      const deep = { id: '600', task: { rawRows: Array.from({ length: 601 }, (_, i) => make(String(i), i ? String(i - 1) : '')) } };
      return { cycle: error(cyclic), missing: error(missing), deep: treePath(proj, deep).length };
    });
    assert.match(pathChecks.cycle, /cycle/);
    assert.match(pathChecks.missing, /missing parent/);
    assert.equal(pathChecks.deep, 601, 'long ancestor paths must not be silently truncated');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/annotator-mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#btn-home').click();
    await page.locator('[data-open="Browser verification"]').click();
    await page.waitForFunction(() => !state.busy && state.viewById?.size > 1 && state.project?.caps.total === 12);

    // A small imported source proves exact budgets across thread boundaries.
    await page.locator('#btn-home').click();
    const columns = 'task_index,thread_id,node_id,parent_id,role,created_utc,state,replies,is_target,text,label';
    const csv = [columns,
      '1,one,p1,,op,2025-01-01,ok,2,1,First post,',
      '1,one,a,p1,comment,2025-01-01,ok,1,0,Direct reply,',
      '1,one,b,a,target,2025-01-01,ok,0,1,Deep target,caution_and_advice',
      '2,two,p2,,op,2025-01-02,ok,2,1,Second post,',
      '2,two,c,p2,target,2025-01-02,ok,0,1,Another direct reply,',
      '2,two,d,p2,comment,2025-01-03,ok,0,0,Last reply,'].join('\n');
    await page.locator('#file-input').setInputFiles({ name: 'fixture.csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFF' + csv) });
    await page.waitForFunction(() => state.project?.name === 'fixture' && state.viewById?.size === 3);
    await page.locator('#btn-settings').click();
    await page.locator('#set-depth').fill('1');
    await page.locator('#set-total').fill('2');
    await page.locator('#btn-apply-settings').click();
    await page.waitForFunction(() => !state.busy && state.project.caps.total === 2);
    assert.match(await page.locator('#scope-summary').textContent(), /≤ 2 comments per post/);
    assert.equal(await page.locator('#thread .c').count(), 2);
    await page.locator('#btn-next').click();
    await page.waitForFunction(() => state.viewById?.has('p2'));
    assert.equal(await page.locator('#thread .c').count(), 3, 'second thread gets its own cap of 2 comments');
    assert.equal(await page.locator('#btn-next').isDisabled(), true);
    await page.locator('#queue-search').fill('no matching title');
    assert.match(await page.locator('#thread-queue').textContent(), /No matching/);
    await page.locator('#queue-search').fill('');
    await page.locator('#btn-settings').click();
    await page.locator('#btn-reset-filters').click();
    await page.locator('#btn-apply-settings').click();
    await page.waitForFunction(() => !state.busy && !state.project.caps.total);
    assert.equal(await page.locator('#thread .c').count(), 3);
    await page.evaluate(async () => {
      const proj = state.project;
      repository.set(LS_CAPS(proj.name), { comments: 1, depth: 1, total: 2 });
      repository.set(LS_POS(proj.name), 1);
      proj.caps = getCaps(proj.name);
      await startProject(proj, 'point', 'relabel');
    });
    assert.equal(await page.evaluate(() => state.project.caps.comments), undefined);
    // Target exemption: depth 1 trims context but target b (level 2) and its chain stay.
    assert.equal(await page.evaluate(() => state.viewById?.has('b')), true);
    assert.equal(await page.evaluate(() => state.viewById?.size), 3);
    assert.equal(await page.locator('#point-btn').textContent(), 'Point');
    await page.locator('#point-btn').click();
    await page.waitForFunction(() => state.pointed === 'b');
    await page.locator('[data-node="b"] .label-select').selectOption('sympathy_and_support');
    assert.equal(await page.locator('#point-btn').textContent(), 'Next ▶');
    await page.locator('#point-btn').click();
    await page.waitForFunction(() => state.viewById?.has('c'));
    assert.equal(await page.locator('#point-btn').textContent(), 'Point');
    await page.locator('#point-btn').click();
    await page.waitForFunction(() => state.pointed === 'c');
    await page.locator('[data-node="c"] .label-select').selectOption('sympathy_and_support');
    assert.equal(await page.locator('#point-btn').textContent(), 'Next ▶');
    await page.locator('#btn-prev').click();
    await page.waitForFunction(() => state.viewById?.has('b'));
    await page.locator('[data-node="b"] .clearbtn').click();
    await page.locator('#btn-settings').click();
    await page.locator('#btn-reset-filters').click();
    await page.locator('#btn-apply-settings').click();
    await page.waitForFunction(() => !state.busy);
    await page.reload();
    await page.waitForFunction(() => state.project?.name === 'fixture' && !state.busy && state.viewById?.has('b'));
    assert.equal(await page.locator('[data-node="b"] .label-select').inputValue(), '', 'cleared source label stays cleared after reload');
    await page.evaluate(() => { state.labels.c.row = null; });
    await page.locator('#btn-view').click();
    await page.locator('#v-text').fill('');
    await page.locator('#v-scope').selectOption('labeled');
    assert.equal(await page.locator('#v-body tr').count(), 1, 'cloud labels without stored source rows remain reviewable');
    await page.keyboard.press('Escape');
    await page.locator('#btn-export').click();
    await page.locator('input[name="exp-schema"][value="tree"]').check();
    await page.locator('input[name="exp-format"][value="json"]').check();
    await page.locator('input[name="exp-scope"][value="full"]').check();
    const importedDownload = page.waitForEvent('download');
    await page.locator('#btn-do-export').click();
    const importedFile = await importedDownload;
    const importedRecords = JSON.parse(fs.readFileSync(await importedFile.path(), 'utf8'));
    assert.equal(importedRecords.length, 2, 'imported targets support target export structures');
    assert.deepEqual(importedRecords.map(row => row.tree_path.at(-1).text), ['Deep target', 'Another direct reply']);
    assert.equal(importedRecords.find(row => row.post_id === 'b').class_label, '', 'full export preserves the explicit clear');
    await page.locator('#btn-home').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-forget="fixture"]').click();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert.equal(await page.evaluate(() => repository.get(LS_LABELS('fixture'))), null, 'pagehide cannot restore a deleted project label store');
    assert.deepEqual(errors, []);
    console.log('Passed: real dataset, strict filters, per-thread cap (no blocked threads), label persistence, review, export, navigation, search, mobile, filter reset, legacy caps, relabel target exemption, and Point mode.');
    await page.close();
  } finally { await browser.close(); restoreConfig(); }
})().catch(error => { restoreConfig(); console.error(error); process.exit(1); });
