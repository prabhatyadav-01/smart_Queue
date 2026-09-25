import { mountThemeSwitcher, getTheme } from '../core/theme.js';
import { api, post } from '../core/api.js';
import { initTilt, initMagnetic, initHover3D } from '../core/motion.js';
import { initParticleDrift } from '../core/particle-drift.js';
import { $, $$, setBusy, toast } from '../core/ui.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const params = new URLSearchParams(location.search);

/** Only allow same-origin relative redirects (prevents open-redirects). */
function safeNext() {
  const next = params.get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

function finish(user) {
  const staff = user && (user.role === 'admin' || user.role === 'staff');
  location.href = safeNext() || (staff ? '/admin.html' : '/app.html');
}

function showStep(step) {
  $$('[data-step]').forEach((el) => {
    el.hidden = el.dataset.step !== step;
  });
  const input = $(`[data-step="${step}"] input:not([type=hidden]):not(.hp-field)`);
  setTimeout(() => input?.focus(), 60);
}

function showError(form, message) {
  const el = $('[data-error]', form);
  el.textContent = message || '';
  el.hidden = !message;
}

async function handleNext(result) {
  if (result.next === 'done') return finish(result.user);
  if (result.next === 'otp' || result.next === 'totp') {
    showStep('totp');
    if (result.email) {
      const desc = $('[data-otp-desc]');
      if (desc) desc.textContent = `Enter the 6-digit verification code sent to ${result.email}.`;
    }
    if (result.otp) {
      toast(`Verification code: ${result.otp}`, { type: 'info', timeout: 15000 });
      const banner = $('[data-otp-banner]');
      if (banner) {
        banner.innerHTML = `<span class="pill accent">Code sent</span> <b>${result.otp}</b> <small class="muted">(check console or use above)</small>`;
        banner.hidden = false;
      }
    }
    return;
  }
  if (result.next === 'totp_setup') {
    showStep('totp_setup');
    await loadEnrolment();
  }
}

/* ---------- Tabs ---------- */
function setTab(tab) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('[data-form="login"]').hidden = tab !== 'login';
  $('[data-form="register"]').hidden = tab !== 'register';
  $('[data-title]').textContent = tab === 'login' ? 'Welcome back' : 'Create your account';
  $('[data-subtitle]').textContent = tab === 'login'
    ? 'Sign in to get and track your tokens.'
    : 'Takes a minute. You will link an authenticator app next.';
}

/* ---------- Password strength ---------- */
function strength(pw) {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw) || /\s/.test(pw)) score++;
  return pw.length < 10 ? Math.min(score, 1) : score;
}
const STRENGTH_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];

/* ---------- Forms ---------- */
function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function bindCredentialForms() {
  const login = $('[data-form="login"]');
  login.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { email, password, website } = formData(login);
    if (!email || !password) return showError(login, 'Enter your email and password.');
    const btn = $('button[type=submit]', login);
    setBusy(btn, true, 'Checking…');
    showError(login, '');
    try {
      await handleNext(await post('/api/auth/login', { email, password, website }, { human: true }));
    } catch (err) {
      showError(login, err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  const register = $('[data-form="register"]');
  const pass = $('#re-pass');
  pass.addEventListener('input', () => {
    const s = strength(pass.value);
    $('[data-strength]').dataset.level = String(s);
    $('[data-strength-label]').textContent = pass.value ? STRENGTH_LABELS[s] : 'At least 10 characters. A short phrase works well.';
  });
  register.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { name, email, password, website } = formData(register);
    if (!name || name.trim().length < 2) return showError(register, 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return showError(register, 'Enter a valid email address.');
    if ((password || '').length < 10) return showError(register, 'Password must be at least 10 characters.');
    const btn = $('button[type=submit]', register);
    setBusy(btn, true, 'Creating…');
    showError(register, '');
    try {
      await handleNext(await post('/api/auth/register', { name: name.trim(), email, password, website }, { human: true }));
    } catch (err) {
      showError(register, err.message);
    } finally {
      setBusy(btn, false);
    }
  });
}

function bindCodeForm(step) {
  const form = $(`[data-form="${step}"]`);
  const input = $('input', form);
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(input.value)) return showError(form, 'Enter the 6-digit verification code.');
    const btn = $('button[type=submit]', form);
    if (btn.disabled) return;
    setBusy(btn, true, 'Verifying…');
    showError(form, '');
    try {
      const endpoint = step === 'totp' ? '/api/auth/otp/verify' : '/api/auth/totp/verify';
      const res = await post(endpoint, { code: input.value });
      toast('Signed in successfully', { type: 'success' });
      finish(res.user);
    } catch (err) {
      showError(form, err.message);
      input.select();
    } finally {
      setBusy(btn, false);
    }
  });

  const resendBtn = $('[data-resend]');
  if (resendBtn && !resendBtn.dataset.bound) {
    resendBtn.dataset.bound = 'true';
    resendBtn.addEventListener('click', async () => {
      setBusy(resendBtn, true, 'Sending…');
      try {
        const res = await post('/api/auth/otp/resend');
        toast(res.message || 'New code sent!', { type: 'info' });
        if (res.otp) {
          toast(`Verification code: ${res.otp}`, { type: 'info', timeout: 15000 });
          const banner = $('[data-otp-banner]');
          if (banner) {
            banner.innerHTML = `<span class="pill accent">New code</span> <b>${res.otp}</b> <small class="muted">(check console or use above)</small>`;
            banner.hidden = false;
          }
        }
      } catch (err) {
        toast(err.message, { type: 'danger' });
      } finally {
        setBusy(resendBtn, false);
      }
    });
  }
}

async function loadEnrolment() {
  const box = $('[data-qr]');
  try {
    const { qr, secret } = await post('/api/auth/totp/setup');
    const img = new Image();
    img.src = qr;
    img.alt = 'QR code for your authenticator app';
    img.width = 220;
    img.height = 220;
    box.replaceChildren(img);
    $('[data-secret]').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    $('[data-copy]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(secret);
        toast('Key copied', { type: 'success', timeout: 2000 });
      } catch {
        toast('Copy failed — select the key and copy it manually', { type: 'warning' });
      }
    };
  } catch (err) {
    if (err.code === 'CONFLICT') return showStep('totp');
    box.textContent = err.message;
  }
}

/* ---------- Google Identity Services ---------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.append(s);
  });
}

async function initGoogle(clientId, supabaseUrl, supabaseAnonKey) {
  const slot = $('[data-google]');

  // Check if Supabase Auth is available
  let supaClient = null;
  if (supabaseUrl && supabaseAnonKey && window.supabase) {
    try {
      supaClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
    } catch {
      // fallback
    }
  }

  // If no Google Client ID and no Supabase URL
  if (!clientId && !supabaseUrl) {
    slot.innerHTML = '<p class="google-off">Google sign-in isn\'t enabled on this server, so use email with an authenticator app. To enable it, set <code>GOOGLE_CLIENT_ID</code> or <code>SUPABASE_URL</code>.</p>';
    $('[data-or]').hidden = true;
    return;
  }

  // If Google Client ID is configured, use Google Identity Services
  if (clientId) {
    try {
      await loadScript(GSI_SRC);
    } catch (err) {
      slot.textContent = err.message;
      return;
    }
    const g = window.google.accounts.id;
    g.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      auto_select: false,
      itp_support: true,
      callback: async ({ credential }) => {
        try {
          await handleNext(await post('/api/auth/google', { credential }, { human: true }));
        } catch (err) {
          toast('Google sign-in failed', { body: err.message, type: 'danger' });
        }
      },
    });
    const render = () => {
      slot.replaceChildren();
      g.renderButton(slot, {
        theme: getTheme() === 'dark' ? 'filled_black' : 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: Math.min(400, slot.clientWidth || 360),
      });
    };
    render();
    document.addEventListener('themechange', render);
    return;
  }

  // If Supabase URL is available without direct Google Client ID, use Supabase OAuth
  if (supabaseUrl && supabaseAnonKey) {
    slot.innerHTML = `
      <button type="button" class="btn btn-secondary btn-lg" id="btn-supabase-google" style="width:100%; display:flex; align-items:center; justify-content:center; gap:10px;">
        <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
        Continue with Google
      </button>
    `;
    const btn = $('#btn-supabase-google');
    if (btn) {
      btn.addEventListener('click', async () => {
        try {
          if (!window.supabase) {
            await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
          }
          const client = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
          await client.auth.signInWithOAuth({
            provider: 'google',
            options: {
              redirectTo: window.location.origin + '/login.html',
            },
          });
        } catch (err) {
          toast('Supabase Google sign-in failed', { body: err.message, type: 'danger' });
        }
      });
    }
  }
}

/* ---------- Boot ---------- */
async function boot() {
  mountThemeSwitcher($('[data-theme-switch]'));
  initTilt($('[data-auth-stack]'), { max: 10 });
  initMagnetic();
  initHover3D();
  initParticleDrift();
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  if (params.get('tab') === 'register') setTab('register');
  bindCredentialForms();
  bindCodeForm('totp');
  bindCodeForm('totp_setup');
  $('[data-switch]').addEventListener('click', async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      showStep('credentials');
    }
  });

  // Check for Supabase OAuth callback tokens or errors
  const hash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
  const search = window.location.search ? window.location.search.replace(/^\?/, '') : '';
  const allParams = new URLSearchParams(hash + (hash && search ? '&' : '') + search);
  const accessToken = allParams.get('access_token');
  const oauthError = allParams.get('error_description') || allParams.get('error');

  if (oauthError) {
    toast('Google sign-in error: ' + decodeURIComponent(oauthError), { type: 'danger' });
    window.history.replaceState(null, '', window.location.pathname);
  } else if (accessToken) {
    try {
      const next = await post('/api/auth/supabase-session', { access_token: accessToken });
      window.history.replaceState(null, '', window.location.pathname);
      return handleNext(next);
    } catch (err) {
      toast('Google sign-in failed', { body: err.message, type: 'danger' });
    }
  }

  try {
    const me = await api('/api/auth/me');
    if (me.user?.verified) return finish(me.user);
    if (me.pending) await handleNext({ next: me.pending });
  } catch {
    // not signed in — stay on credentials
  }
  try {
    const config = await api('/api/config');
    await initGoogle(config.googleClientId, config.supabaseUrl, config.supabaseAnonKey);
  } catch (err) {
    console.warn('Could not load auth configuration:', err);
    const slot = $('[data-google]');
    if (slot) slot.innerHTML = '';
    const orSlot = $('[data-or]');
    if (orSlot) orSlot.hidden = true;
  }
}

boot();
