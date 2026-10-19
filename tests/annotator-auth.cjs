// Auth gate checks: local mode stays open, a configured install is blocked
// until Supabase answers, and a bad credential surfaces the server error.
// Run:  node tests/annotator-auth.cjs   (same PLAYWRIGHT_MODULE support as annotator-browser)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'annotator', 'config.js');
const CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };

function withConfig(config, fn) {
  const backup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  fs.writeFileSync(configPath, '// test fixture — restored automatically\nwindow.SUPABASE_CONFIG = '
    + JSON.stringify(config) + ';\n');
  const restore = () => {
    if (backup === null) fs.rmSync(configPath, { force: true });
    else fs.writeFileSync(configPath, backup);
  };
  return Promise.resolve().then(fn).then(value => { restore(); return value; }, error => { restore(); throw error; });
}

function serveRepo(umdFile) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = url === '/__supabase.js' && umdFile ? umdFile : path.join(root, url.replace(/^\/+/, '') || 'annotator.html');
    if (!file.startsWith(root) && file !== umdFile) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    const fileUrl = pathToFileURL(path.join(root, 'annotator.html')).href;

    // 1. No config → local mode: no gate, no cloud status, no sign-out.
    await withConfig(null, async () => {
      await page.goto(fileUrl);
      assert.equal(await page.locator('#auth-gate').isVisible(), false, 'gate must stay hidden without config');
      assert.match(await page.locator('#workspace-badge').textContent(), /Local workspace/);
      assert.equal(await page.locator('#st-sync').isVisible(), false, 'cloud status hidden in local mode');
      assert.equal(await page.locator('#btn-signout').isVisible(), false);
      await page.screenshot({ path: '/tmp/annotator-auth-local.png' });
    });

    // 2. Configured but the Supabase library cannot load → the app stays locked.
    await withConfig({ url: 'http://127.0.0.1:9/supabase', anonKey: 'test-anon-key', allowSignup: true,
      cdn: pathToFileURL(path.join(os.tmpdir(), 'definitely-not-supabase.js')).href }, async () => {
      await page.goto(fileUrl);
      await page.waitForSelector('#auth-gate:not([hidden])', { timeout: 5000 });
      await page.waitForFunction(() => (document.querySelector('#auth-note').textContent || '').includes('Could not load'),
        undefined, { timeout: 5000 });
      assert.equal(await page.locator('#auth-email').isVisible(), true);
      assert.equal(await page.locator('#btn-signout').isVisible(), false);
      // The gate is a hard lock: neither the backdrop nor Escape may dismiss it.
      await page.locator('#auth-gate').click({ position: { x: 5, y: 5 } });
      assert.equal(await page.locator('#auth-gate').isVisible(), true, 'backdrop click must not dismiss the gate');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#auth-gate').isVisible(), true, 'Escape must not dismiss the gate');
      await page.screenshot({ path: '/tmp/annotator-auth-gate.png' });
    });

    // 3. Real library, unreachable API → the sign-in form reports the failure.
    let umd = path.join(os.tmpdir(), 'supabase-umd.js');
    try {
      if (!fs.existsSync(umd)) {
        const response = await fetch(CDN_URL);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        fs.writeFileSync(umd, await response.text());
      }
      const server = await serveRepo(umd);
      const origin = 'http://127.0.0.1:' + server.address().port;
      try {
        await withConfig({ url: 'http://127.0.0.1:9/supabase', anonKey: 'test-anon-key', allowSignup: true,
          cdn: origin + '/__supabase.js' }, async () => {
          await page.goto(origin + '/annotator.html');
          await page.waitForSelector('#auth-gate:not([hidden])', { timeout: 5000 });
          await page.locator('#auth-email').fill('annotator@example.org');
          await page.locator('#auth-password').fill('not-a-real-password');
          await page.locator('#auth-submit').click();
          await page.waitForFunction(() => (document.querySelector('#auth-error').textContent || '').trim().length > 0,
            undefined, { timeout: 20000 });
          assert.equal(await page.locator('#auth-gate').isVisible(), true, 'gate stays up after a failed sign-in');

          // Sign-up is gated by an access code, checked before any network call.
          await page.locator('#auth-signup').click();
          assert.equal(await page.locator('#auth-code').isVisible(), true, 'access code field appears in sign-up mode');
          await page.locator('#auth-password').fill('not-a-real-password');
          await page.locator('#auth-code').fill('WRONG-CODE');
          await page.locator('#auth-submit').click();
          await page.waitForFunction(() => (document.querySelector('#auth-error').textContent || '').includes('access code'),
            undefined, { timeout: 5000 });
          await page.locator('#auth-signup').click();          // back to sign in
          assert.equal(await page.locator('#auth-code').isVisible(), false, 'access code field hidden again');
          assert.equal(await page.locator('#auth-submit').textContent(), 'Sign in');
        });
      } finally { server.close(); }
    } catch (error) {
      if (/fetch|ENOTFOUND|ECONNREFUSED|network/i.test(error.message)) {
        console.log('Skipped unreachable-API check (no network for the Supabase library): ' + error.message);
      } else throw error;
    }

    // 4. A stored session starts in restore splash (no sign-in form flash) and
    //    an unreachable API then returns a strict, undismissable sign-in form.
    let splashServer;
    try {
      splashServer = await serveRepo(umd);
      const origin = 'http://127.0.0.1:' + splashServer.address().port;
      await withConfig({ url: 'http://127.0.0.1:9/supabase', anonKey: 'test-anon-key', allowSignup: true,
        cdn: origin + '/__supabase.js' }, async () => {
        // Hold the library load so the restore-splash window is observable, then fail fast.
        await page.route('**/__supabase.js', route => new Promise(resolve =>
          setTimeout(() => { route.continue(); resolve(); }, 1500)));
        await page.addInitScript(() => localStorage.setItem('sb-test-auth-token',
          JSON.stringify({ access_token: 'expired', refresh_token: 'stale', expires_at: 1 })));
        await page.goto(origin + '/annotator.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-gate:not([hidden])', { timeout: 5000 });
        assert.equal(await page.locator('#auth-form').isVisible(), false, 'stored session must not flash the sign-in form');
        assert.match(await page.locator('#auth-title').textContent(), /Restoring/);
        await page.waitForSelector('#auth-form:visible', { timeout: 20000 });
        assert.equal(await page.locator('#auth-gate').isVisible(), true, 'unreachable API resolves to signed out, not open app');
        assert.match(await page.locator('#auth-title').textContent(), /Sign in to annotate/, 'splash title resets with the form');
        await page.locator('#auth-gate').click({ position: { x: 5, y: 5 } });
        assert.equal(await page.locator('#auth-gate').isVisible(), true, 'signed-out gate stays up after backdrop click');
      });
    } finally { if (splashServer) splashServer.close(); }

    // 5. Authenticated account switches must never expose another account's local workspace.
    const accountServer = await serveRepo();
    try {
      const origin = 'http://127.0.0.1:' + accountServer.address().port;
      await page.unroute('**/__supabase.js');
      await page.route('**/__supabase.js', route => route.fulfill({ contentType: 'text/javascript', body: `
        window.supabase = { createClient() {
          let listener;
          function query() {
            return { select() { return this; }, eq() { return this; }, order() { return this; },
              range() { return this; }, in() { return this; }, delete() { return this; },
              upsert() { return this; }, single() { this.one = true; return this; },
              maybeSingle() { this.one = true; return this; },
              then(resolve) { return Promise.resolve({ data: this.one ? { id: 'fixture-project' } : [], error: null }).then(resolve); }
            };
          }
          return { from: query, auth: {
            onAuthStateChange(fn) {
              listener = fn;
              window.fixtureAuthSwitch = email => listener('SIGNED_IN', { user: { id: email, email } });
            },
            async getSession() { return { data: { session: null }, error: null }; },
            async signInWithPassword({ email }) { return { data: { session: { user: { id: email, email } } }, error: null }; },
            async signOut() { listener('SIGNED_OUT', null); return { error: null }; }
          } };
        } };
      ` }));
      await withConfig({ url: 'https://example.invalid', anonKey: 'fixture-key', cdn: origin + '/__supabase.js' }, async () => {
        await page.goto(origin + '/annotator.html');
        async function login(email) {
          await page.locator('#auth-email').fill(email);
          await page.locator('#auth-password').fill('fixture-password');
          await page.locator('#auth-submit').click();
          await page.waitForSelector('#auth-gate[hidden]', { state: 'attached' });
        }
        await login('account-a@example.org');
        const source = 'task_index,node_id,parent_id,role,text,label\n1,post,,op,Private post,\n1,target,post,target,Private target,';
        await page.locator('#file-input').setInputFiles({ name: 'Private account A.csv', mimeType: 'text/csv', buffer: Buffer.from(source) });
        await page.waitForFunction(() => state.project?.name === 'Private account A' && !state.busy);
        await page.locator('[data-node="target"] .label-select').selectOption('caution_and_advice');
        // Immediate sign-out also flushes the debounced local label save.
        await page.locator('#btn-signout-top').click();
        await login('account-b@example.org');
        assert.equal(await page.locator('[data-open="Private account A"]').count(), 0);
        assert.equal(await page.evaluate(() => state.project), null);
        assert.equal(await page.locator('#workspace').isVisible(), false);
        await page.locator('#btn-signout').click();
        await login('account-a@example.org');
        await page.locator('[data-open="Private account A"]').click();
        await page.waitForFunction(() => state.project?.name === 'Private account A' && !state.busy);
        assert.equal(await page.locator('[data-node="target"] .label-select').inputValue(), 'caution_and_advice');
        await page.evaluate(() => window.fixtureAuthSwitch('account-b@example.org'));
        await page.waitForSelector('#auth-gate[hidden]', { state: 'attached' });
        assert.equal(await page.evaluate(() => state.project), null, 'an external account switch closes the previous account workspace');
        assert.equal(await page.locator('[data-open="Private account A"]').count(), 0);
      });
    } finally { accountServer.close(); }

    assert.deepEqual(errors, []);
    console.log('Passed: local mode, blocking gate, sign-in failures, restore splash, account isolation, and sign-out persistence.');
    await page.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
