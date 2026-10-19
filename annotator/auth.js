'use strict';
/* Supabase sign-in gate for the annotator.
   Reads window.SUPABASE_CONFIG (generated from .env by gen_config.py).
   No config → local-only mode: no gate, no network, identical to before. */
window.AuthGate = (() => {
  const $ = s => document.querySelector(s);
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  const NOTE_DEFAULT = 'Labels sync to Supabase for your account and stay in this browser as a fallback.';
  // Shared access code for new accounts. The gate checks it here for instant
  // feedback; supabase/migrations/..._annotator_auth.sql enforces it on auth.users.
  const SIGNUP_CODE = 'SMCADL';
  const cfg = window.SUPABASE_CONFIG || null;
  const placeholder = v => /^(?:<.*>|your[-_].*|replace.?me|x{3,}|example.*)$/i.test(String(v || '').trim());
  const configured = !!(cfg && cfg.url && cfg.anonKey && !placeholder(cfg.url) && !placeholder(cfg.anonKey));

  let client = null;
  let session = null;
  let entered = false;
  let entering = false;
  let entryGeneration = 0;
  let mode = 'signin';            // 'signin' | 'signup' (signup reveals the access code)
  const listeners = [];
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  // Configured installs block the app before first paint; the CDN load follows.
  // A stored session starts in splash mode so a reload never flashes the form.
  if (configured) {
    const stored = (() => {
      try { return Object.keys(localStorage).some(key => /^sb-.+-auth-token$/.test(key)); }
      catch (error) { return false; }
    })();
    if (stored) showSplash('Restoring your session…');
    else showGate('Connecting…');
    if (cfg.allowSignup === false) { const s = $('#auth-signup'); if (s) s.hidden = true; }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function setError(message) {
    const el = $('#auth-error');
    if (el) el.textContent = message || '';
  }
  function setNote(message) {
    const el = $('#auth-note');
    if (el) el.textContent = message || NOTE_DEFAULT;
  }
  function setBusy(busy) {
    const submit = $('#auth-submit');
    const signup = $('#auth-signup');
    if (submit) { submit.disabled = busy; submit.textContent = busy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in'); }
    if (signup) signup.disabled = busy;
  }
  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    const signingUp = mode === 'signup';
    const field = $('#auth-code-field');
    const code = $('#auth-code');
    if (field) field.hidden = !signingUp;
    if (code) { code.required = signingUp; if (!signingUp) code.value = ''; }
    const title = $('#auth-title');
    if (title) title.textContent = signingUp ? 'Create your account' : 'Sign in to annotate';
    const submit = $('#auth-submit');
    if (submit && !submit.disabled) submit.textContent = signingUp ? 'Create account' : 'Sign in';
    const signup = $('#auth-signup');
    if (signup) signup.textContent = signingUp ? 'Back to sign in' : 'Create account';
    const password = $('#auth-password');
    if (password) password.autocomplete = signingUp ? 'new-password' : 'current-password';
    setError('');
  }
  function showGate(message) {
    setError('');
    setNote(message || NOTE_DEFAULT);
    setMode('signin');
    const form = $('#auth-form');
    if (form) form.hidden = false;
    const gate = $('#auth-gate');
    if (gate) gate.hidden = false;
    const email = $('#auth-email');
    if (email && !message) email.focus();
  }
  function showSplash(message) {
    setError('');
    const gate = $('#auth-gate');
    if (gate) gate.hidden = false;
    const form = $('#auth-form');
    if (form) form.hidden = true;
    const title = $('#auth-title');
    if (title) title.textContent = message;
  }
  function hideGate() {
    const gate = $('#auth-gate');
    if (gate) gate.hidden = true;
    setError('');
    setNote(NOTE_DEFAULT);
  }
  function identity() {
    const email = session && session.user ? session.user.email : '';
    const visible = configured && !!email;
    ['btn-signout', 'btn-signout-top'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = !visible;
    });
    const badge = $('#workspace-badge');
    if (badge) badge.textContent = !configured ? '● Local workspace' : (email ? '● ' + email : '● Signed out');
    const signup = $('#auth-signup');
    if (signup) {
      signup.hidden = configured && cfg.allowSignup === false;
      if (signup.hidden && mode === 'signup') setMode('signin');
    }
  }
  function notify() {
    for (const fn of listeners) {
      try { fn(session ? session.user : null); } catch (error) { console.error(error); }
    }
  }

  /* Sign-in finished: pull the account's projects and labels, then reveal the app. */
  async function enter() {
    if (entering || entered) return;
    const generation = ++entryGeneration;
    const accountId = session?.user?.id;
    let blocked = false;
    entering = true;
    const gate = $('#auth-gate');
    if (gate) gate.hidden = false;
    setNote('Loading your annotations…');
    setError('');
    try {
      if (window.RemoteSync) await window.RemoteSync.signIn();
    } catch (error) {
      if (error.staleSession) return;
      console.error('[RemoteSync]', error);
      if (error.blockWorkspace) {
        blocked = true;
        showGate('Could not open account storage: ' + error.message);
        return;
      }
      if (window.toast) window.toast('Cloud sync unavailable: ' + error.message, 4500);
    } finally {
      if (generation !== entryGeneration || session?.user?.id !== accountId) return;
      entering = false;
      if (blocked) return;
      entered = true;
      setNote(NOTE_DEFAULT);
      hideGate();
      identity();
      notify();
    }
  }

  async function signIn(event) {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: $('#auth-email').value.trim(),
        password: $('#auth-password').value,
      });
      if (error) { setError(error.message); return; }
      session = data.session;
      await enter();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (mode === 'signup') return signUp();
    return signIn(event);
  }

  async function signUp() {
    if (!client) return;
    const code = ($('#auth-code').value || '').trim().toUpperCase();
    if (code !== SIGNUP_CODE) {
      setError('That access code is not valid. Ask your project lead for the current code.');
      $('#auth-code').focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data, error } = await client.auth.signUp({
        email: $('#auth-email').value.trim(),
        password: $('#auth-password').value,
        options: { data: { access_code: code } },     // checked by the auth.users trigger
      });
      if (error) { setError(error.message); return; }
      if (data.session) { session = data.session; await enter(); }
      else setError('Account created — confirm your email, then sign in.');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    entryGeneration++;
    entering = false;
    entered = false;
    if (window.RemoteSync) window.RemoteSync.signOut();
    if (client) { try { await client.auth.signOut(); } catch (error) { console.error(error); } }
    session = null;
    showGate();
    identity();
    notify();
  }

  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-signup').addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
  ['btn-signout', 'btn-signout-top'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', signOut);
  });

  (async () => {
    if (!configured) { identity(); resolveReady(); notify(); return; }
    try {
      await loadScript(cfg.cdn || CDN);
    } catch (error) {
      showGate('Could not load the Supabase library — check your connection and reload.');
      identity();
      resolveReady();
      notify();
      return;
    }
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,   // the annotator keeps its own #p=… routing hash
      },
    });
    client.auth.onAuthStateChange((event, next) => {
      const previousAccount = session?.user?.id;
      session = next;
      identity();
      if (event === 'SIGNED_OUT') {
        entryGeneration++;
        entering = false;
        entered = false;
        if (window.RemoteSync) window.RemoteSync.signOut();
        showGate();
        notify();
      } else if (event === 'SIGNED_IN' && next) {
        if (previousAccount && previousAccount !== next.user.id) {
          entryGeneration++;
          entering = false;
          entered = false;
          if (window.RemoteSync) window.RemoteSync.signOut();
        }
        enter();
      }
    });
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      session = data.session;
    } catch (error) {
      showGate('Could not reach Supabase: ' + error.message);
      identity();
      resolveReady();
      notify();
      return;
    }
    identity();
    if (session) await enter();
    else showGate();
    resolveReady();
    notify();
  })();

  return {
    whenReady: () => ready,
    isConfigured: () => configured,
    isSignedIn: () => !!(session && session.user),
    user: () => (session ? session.user : null),
    client: () => client,
    onAuth: fn => {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
  };
})();
