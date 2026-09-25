'use strict';

const pg = require('pg');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || '';

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
const WARN = '⚠️  WARN';

function separator(label) {
  console.log('\n' + '─'.repeat(60));
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

async function checkHttpJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'SmartQueue-check/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Request timeout')); });
  });
}

// ── 1. Postgres connectivity & schema ───────────────────────────────────────
async function checkDatabase() {
  separator('1. SUPABASE POSTGRES (via transaction pooler :6543)');

  const pool = new pg.Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    max: 3,
  });

  try {
    // a) Basic connectivity
    const { rows: [ver] } = await pool.query('SELECT version(), current_database(), current_user');
    console.log(`${PASS}  Connected  db=${ver.current_database}  user=${ver.current_user}`);
    console.log(`         PG version: ${ver.version.split(' ').slice(0, 2).join(' ')}`);

    // b) Table inventory
    const { rows: tables } = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const tableNames = tables.map(r => r.table_name);
    const expected = ['audit_log','bookings','counters','notifications','organizations','risk_events','services','sessions','users'];
    const missing  = expected.filter(t => !tableNames.includes(t));
    if (missing.length) {
      console.log(`${FAIL}  Missing tables: ${missing.join(', ')}`);
    } else {
      console.log(`${PASS}  All 9 tables present: ${tableNames.join(', ')}`);
    }

    // c) Row counts
    console.log('\n  Row counts:');
    let allGood = true;
    for (const t of tableNames) {
      const { rows: [{ c }] } = await pool.query(`SELECT COUNT(*) AS c FROM "${t}"`);
      const count = Number(c);
      const ok = count > 0;
      if (!ok) allGood = false;
      console.log(`  ${ok ? '✓' : '✗'}  ${t.padEnd(20)} ${count} rows`);
    }
    if (allGood) console.log(`\n${PASS}  All tables have data`);

    // d) Partial unique index for seat double-booking prevention
    const { rows: indexes } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'bookings' AND indexname = 'ux_bookings_seat';
    `);
    if (indexes.length > 0) {
      console.log(`${PASS}  Partial unique index ux_bookings_seat is present`);
      console.log(`         ${indexes[0].indexdef}`);
    } else {
      console.log(`${FAIL}  Partial unique index ux_bookings_seat NOT found!`);
    }

    // e) Identity sequences
    const { rows: seqs } = await pool.query(`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = 'public';
    `);
    console.log(`${PASS}  ${seqs.length} identity sequences found`);

    return pool;
  } catch (err) {
    console.log(`${FAIL}  Database connection error: ${err.message}`);
    await pool.end().catch(() => {});
    return null;
  }
}

// ── 2. Supabase Auth API ─────────────────────────────────────────────────────
async function checkAuth() {
  separator('2. SUPABASE AUTH API (service role)');

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false }
  });

  // a) list users
  try {
    const { data, error } = await sb.auth.admin.listUsers();
    if (error) {
      console.log(`${FAIL}  listUsers error: ${error.message}`);
    } else {
      console.log(`${PASS}  Auth admin API reachable — ${data.users.length} auth user(s)`);
      for (const u of data.users) {
        const provider = u.app_metadata?.provider || u.identities?.[0]?.provider || 'unknown';
        console.log(`         • ${u.email || u.id} (provider: ${provider})`);
      }
    }
  } catch (err) {
    console.log(`${FAIL}  Auth admin API error: ${err.message}`);
  }

  // b) Check Auth settings endpoint is accessible
  try {
    const res = await checkHttpJson(`${SUPABASE_URL}/auth/v1/settings`);
    if (res.status === 200) {
      console.log(`${PASS}  Auth /v1/settings endpoint: HTTP 200`);
    } else {
      console.log(`${WARN}  Auth /v1/settings returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`${WARN}  Auth /v1/settings: ${err.message}`);
  }
}

// ── 3. Google OAuth provider via Supabase ────────────────────────────────────
async function checkGoogleOAuth() {
  separator('3. GOOGLE OAUTH (via Supabase Auth provider)');

  const sbAnon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false }
  });

  // a) Generate OAuth URL
  try {
    const { data, error } = await sbAnon.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'http://localhost:3000/login.html', skipBrowserRedirect: true },
    });
    if (error) {
      console.log(`${FAIL}  OAuth URL generation error: ${error.message}`);
    } else if (data?.url) {
      const url = new URL(data.url);
      console.log(`${PASS}  Google OAuth URL generated successfully`);
      console.log(`         Host:     ${url.host}`);
      console.log(`         Path:     ${url.pathname}`);
      console.log(`         Provider: ${url.searchParams.get('provider')}`);
      console.log(`         Full URL: ${data.url}`);
    } else {
      console.log(`${WARN}  OAuth returned no URL and no error`);
    }
  } catch (err) {
    console.log(`${FAIL}  OAuth error: ${err.message}`);
  }

  // b) Probe the Supabase /auth/v1/authorize endpoint directly
  try {
    const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google`;
    const res = await checkHttpJson(authUrl);
    // 302 redirect to Google is expected; 400 means Google not configured in Supabase dashboard
    if (res.status === 302 || res.status === 301) {
      console.log(`${PASS}  Google provider is ENABLED in Supabase Dashboard (HTTP ${res.status} redirect to Google)`);
    } else if (res.status === 400) {
      console.log(`${FAIL}  Google provider is NOT enabled in Supabase Dashboard (HTTP 400)`);
      console.log(`         You need to: Authentication → Providers → Google → Enable + add Client ID & Secret`);
    } else if (res.status === 422) {
      console.log(`${WARN}  HTTP 422 — Google may be partially configured: ${JSON.stringify(res.body)}`);
    } else {
      console.log(`${WARN}  Unexpected HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    }
  } catch (err) {
    console.log(`${WARN}  Could not probe authorize endpoint: ${err.message}`);
  }
}

// ── 4. Live app API health ───────────────────────────────────────────────────
async function checkAppApi() {
  separator('4. LIVE APP API (http://localhost:3000)');

  try {
    const http = require('http');
    const checkLocal = (path) => new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:3000${path}`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });

    // /api/config
    const cfg = await checkLocal('/api/config');
    if (cfg.status === 200 && cfg.body?.data?.supabaseUrl) {
      console.log(`${PASS}  /api/config   supabaseUrl=${cfg.body.data.supabaseUrl}`);
      console.log(`         googleClientId=${cfg.body.data.googleClientId || '(not set)'}`);
      console.log(`         supabaseAnonKey=${cfg.body.data.supabaseAnonKey ? cfg.body.data.supabaseAnonKey.slice(0,30) + '…' : '(not set)'}`);
    } else {
      console.log(`${FAIL}  /api/config returned unexpected response (HTTP ${cfg.status})`);
    }

    // /api/orgs
    const orgs = await checkLocal('/api/orgs');
    if (orgs.status === 200 && Array.isArray(orgs.body?.data?.orgs)) {
      const count = orgs.body.data.orgs.length;
      console.log(`${PASS}  /api/orgs     ${count} organisations returned from live Supabase`);
      for (const o of orgs.body.data.orgs) {
        console.log(`         • [${o.id}] ${o.name} (${o.category})`);
      }
    } else {
      console.log(`${FAIL}  /api/orgs failed (HTTP ${orgs.status})`);
    }

    // /api/auth/me — should return 401 unauthenticated
    const me = await checkLocal('/api/auth/me');
    if (me.status === 401) {
      console.log(`${PASS}  /api/auth/me  correctly returns 401 when not signed in`);
    } else {
      console.log(`${WARN}  /api/auth/me returned HTTP ${me.status} (expected 401)`);
    }

  } catch (err) {
    console.log(`${WARN}  Could not reach localhost:3000 — is npm run dev running? (${err.message})`);
  }
}

// ── 5. Supabase API-level health ─────────────────────────────────────────────
async function checkSupabaseRest() {
  separator('5. SUPABASE REST API HEALTH');

  try {
    const res = await checkHttpJson(`${SUPABASE_URL}/rest/v1/`);
    if (res.status === 200) {
      console.log(`${PASS}  Supabase REST API is reachable (HTTP 200)`);
    } else {
      console.log(`${WARN}  Supabase REST API returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`${FAIL}  Supabase REST API unreachable: ${err.message}`);
  }

  try {
    const res = await checkHttpJson(`${SUPABASE_URL}/auth/v1/health`);
    if (res.status === 200) {
      console.log(`${PASS}  Supabase Auth health check: HTTP 200 — ${JSON.stringify(res.body)}`);
    } else {
      console.log(`${WARN}  Supabase Auth health returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`${WARN}  Supabase Auth health: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SmartQueue — Supabase DB + Auth + Google OAuth Full Check   ║');
  console.log(`║  ${new Date().toISOString()}                      ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const pool = await checkDatabase();
  await checkAuth();
  await checkGoogleOAuth();
  await checkAppApi();
  await checkSupabaseRest();

  if (pool) await pool.end().catch(() => {});

  console.log('\n' + '─'.repeat(60));
  console.log('  Check complete.');
  console.log('─'.repeat(60) + '\n');
}

main().catch(console.error);
