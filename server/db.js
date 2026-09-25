'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const pg = require('pg');
const { SCHEMA_SQL } = require('../scripts/migrate');

// Ensure 64-bit integers (BIGINT) and numbers from PostgreSQL parse as JS numbers
pg.types.setTypeParser(20, (val) => (val === null ? null : Number.parseInt(val, 10)));
pg.types.setTypeParser(701, (val) => (val === null ? null : Number.parseFloat(val)));
pg.types.setTypeParser(1700, (val) => (val === null ? null : Number.parseFloat(val)));

const txStorage = new AsyncLocalStorage();

/** Convert SQLite-style ? placeholders to Postgres $1, $2, $3... outside of string literals */
function toPgSql(sql) {
  let paramIndex = 1;
  let inString = false;
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && (i === 0 || sql[i - 1] !== '\\')) {
      inString = !inString;
      out += ch;
    } else if (ch === '?' && !inString) {
      out += `$${paramIndex++}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Flatten parameters if passed as multiple arguments or an array */
function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

/**
 * Initializes the database connection.
 * Connects to PostgreSQL via DATABASE_URL / options.connectionString,
 * or boots an in-memory PostgreSQL engine via pg-mem if isMemory or no DATABASE_URL in development.
 */
async function openDb(options = {}) {
  let connectionString = '';
  let isMemory = false;

  if (typeof options === 'string') {
    if (options === ':memory:') {
      isMemory = true;
    } else {
      connectionString = options;
    }
  } else {
    connectionString = options.connectionString || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
    isMemory = Boolean(options.isMemory || options === ':memory:' || !connectionString);
  }

  let pool;
  if (isMemory) {
    console.warn('[db] Running with in-memory Postgres database (pg-mem).');
    if (!connectionString) {
      console.warn('[db] Set DATABASE_URL or SUPABASE_DB_URL to connect to live Supabase Postgres.');
    }
    const { newDb } = require('pg-mem');
    const memDb = newDb();
    memDb.registerExtension('uuid-ossp', (schema) => {
      schema.registerFunction({
        name: 'uuid_generate_v4',
        returns: memDb.public.getType('text'),
        implementation: () => '00000000-0000-0000-0000-000000000000',
      });
    });
    const pgAdapter = memDb.adapters.createPg();
    pool = new pgAdapter.Pool();
  } else {
    const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    pool = new pg.Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: options.maxConnections || (isServerless ? 2 : 20),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    console.log('[db] Connected to PostgreSQL / Supabase pool.');
  }

  // Initialize schema
  await pool.query(SCHEMA_SQL);

  function getClient() {
    return txStorage.getStore() || pool;
  }

  async function query(sql, ...args) {
    const params = normalizeParams(args);
    const pgSql = toPgSql(sql);
    const client = getClient();
    return client.query(pgSql, params);
  }

  async function get(sql, ...args) {
    const res = await query(sql, ...args);
    return res.rows[0] || null;
  }

  async function all(sql, ...args) {
    const res = await query(sql, ...args);
    return res.rows;
  }

  async function run(sql, ...args) {
    let pgSql = sql.trim();
    // If INSERT and lacks RETURNING: handle sessions (id_hash) vs standard tables (id)
    if (/^INSERT\s+INTO\s+sessions\b/i.test(pgSql)) {
      if (!/RETURNING/i.test(pgSql)) pgSql += ' RETURNING id_hash';
    } else if (/^INSERT\s+INTO/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
      pgSql += ' RETURNING id';
    }
    const res = await query(pgSql, ...args);
    const lastId = res.rows?.[0]?.id;
    return {
      rowCount: res.rowCount || 0,
      lastInsertRowid: lastId !== undefined ? Number(lastId) : null,
    };
  }

  /**
   * Run fn inside a transaction.
   * Uses AsyncLocalStorage so all database calls inside fn automatically participate.
   * Nested calls join the outer transaction.
   */
  async function tx(fn) {
    const currentTx = txStorage.getStore();
    if (currentTx) {
      return fn(currentTx);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors if connection died
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Prepares a statement-like object for backwards compatibility.
   */
  function prepare(sql) {
    return {
      get: (...args) => get(sql, ...args),
      all: (...args) => all(sql, ...args),
      run: (...args) => run(sql, ...args),
    };
  }

  async function close() {
    await pool.end();
  }

  const db = {
    pool,
    query,
    get,
    all,
    run,
    tx,
    prepare,
    close,
    isMemory,
  };

  return db;
}

/** Prepared-statement compatibility helper */
function stmt(db, sql) {
  if (!db) throw new Error('Database instance is undefined in stmt()');
  return {
    get: (...args) => db.get(sql, ...args),
    all: (...args) => db.all(sql, ...args),
    run: (...args) => db.run(sql, ...args),
  };
}

/** Transaction helper */
function tx(db, fn) {
  if (!db) throw new Error('Database instance is undefined in tx()');
  return db.tx(fn);
}

module.exports = { openDb, stmt, tx };
