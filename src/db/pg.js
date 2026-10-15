// One tiny query layer, two engines:
//   DATABASE_URL set  → real Postgres via `pg` (Neon, Supabase, RDS…)  ← production
//   otherwise         → PGlite (Postgres compiled to WASM) in ./data/pglite  ← local dev
//   PEOPLEOS_DB=memory → PGlite in memory  ← tests
// Both speak the same SQL, so there is exactly one schema and one set of queries.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema.js';

let engine = null; // { query(sql, params), tx(fn), kind }

async function connect() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    // dates as plain 'YYYY-MM-DD' strings, numerics as JS numbers
    pg.types.setTypeParser(1082, (v) => v);
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    const pool = new pg.Pool({
      connectionString: url,
      max: +(process.env.DB_POOL_MAX || 5),
      ssl: /localhost|127\.0\.0\.1/.test(url) || process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: false },
    });
    return {
      kind: 'postgres',
      query: (sql, params = []) => pool.query(sql, params).then((r) => r.rows),
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (s, p = []) => client.query(s, p).then((r) => r.rows) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  if (process.env.RENDER) {
    // The embedded database needs ~500 MB of RAM, more than Render's free instance has: the deploy would crash.
    console.error('\n  DATABASE_URL is not set. On Render, add a Postgres connection string (a free Neon database works)');
    console.error('  under Environment → DATABASE_URL. The embedded database needs more memory than the free plan has.\n');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { types } = await import('@electric-sql/pglite');
  const dir = process.env.PEOPLEOS_DB === 'memory'
    ? 'memory://'
    : process.env.PEOPLEOS_DB || fileURLToPath(new URL('../../data/pglite', import.meta.url));
  if (!dir.startsWith('memory://')) mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir, {
    parsers: { [types.DATE]: (v) => v, [types.NUMERIC]: (v) => (v === null ? null : Number(v)), [types.INT8]: (v) => (v === null ? null : Number(v)) },
  });
  // PGlite is single-connection: serialise transactions so they never interleave.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    kind: dir.startsWith('memory://') ? 'pglite-memory' : 'pglite',
    query: (sql, params = []) => serial(() => db.query(sql, params).then((r) => r.rows)),
    tx: (fn) => serial(() => db.transaction((t) => fn({ query: (s, p = []) => t.query(s, p).then((r) => r.rows) }))),
    close: () => db.close(),
  };
}

let ready = null;
/** Connects once and applies the schema (idempotent CREATE … IF NOT EXISTS). */
export function init() {
  return (ready ||= (async () => {
    engine = await connect();
    await engine.query(SCHEMA_SQL.replace(/;\s*$/, '')).catch(async () => {
      // pg can't run several statements with parameters; run them one by one
      for (const stmt of SCHEMA_SQL.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await engine.query(stmt);
    });
    return engine;
  })());
}

export async function query(sql, params) { await init(); return engine.query(sql, params); }
export async function one(sql, params) { return (await query(sql, params))[0] ?? null; }
export async function tx(fn) { await init(); return engine.tx(fn); }
export async function dbKind() { await init(); return engine.kind; }
export async function closeDb() { if (engine) await engine.close(); engine = null; ready = null; }
