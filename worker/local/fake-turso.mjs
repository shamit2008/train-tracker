/* A stand-in for Turso's HTTP API (the parts of Hrana v2 pipeline that turso.js uses), backed by Node's SQLite.
   Lets the tests run the real Turso client: its argument encoding, row decoding and conditional batches.
   It follows the protocol as documented; it is not Turso itself. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function fakeTursoFetch(token = 'test-token') {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));

  const value = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.value);
  const encode = (v) => (v == null ? { type: 'null' } : typeof v === 'number' || typeof v === 'bigint'
    ? (Number.isInteger(Number(v)) ? { type: 'integer', value: String(v) } : { type: 'float', value: Number(v) })
    : { type: 'text', value: String(v) });
  function execute(stmt) {
    const p = db.prepare(stmt.sql);
    const args = (stmt.args || []).map(value);
    if (/^\s*(SELECT|WITH)/i.test(stmt.sql)) {
      const rows = p.all(...args);
      const cols = rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : p.columns().map((c) => ({ name: c.name }));
      return { cols, rows: rows.map((r) => cols.map((c) => encode(r[c.name]))), affected_row_count: 0 };
    }
    return { cols: [], rows: [], affected_row_count: Number(p.run(...args).changes) };
  }
  function holds(cond, results, errors) {
    if (!cond) return true;
    if (cond.type === 'ok') return results[cond.step] != null;
    if (cond.type === 'error') return errors[cond.step] != null;
    if (cond.type === 'not') return !holds(cond.cond, results, errors);
    throw new Error('unsupported condition ' + cond.type);
  }

  return async (url, init) => {
    if (!String(url).endsWith('/v2/pipeline')) return new Response('not found', { status: 404 });
    if (init.headers.Authorization !== 'Bearer ' + token) return new Response('unauthorized', { status: 401 });
    const results = JSON.parse(init.body).requests.map((r) => {
      try {
        if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
        if (r.type === 'execute') return { type: 'ok', response: { type: 'execute', result: execute(r.stmt) } };
        if (r.type === 'batch') {
          const step_results = [], step_errors = [];
          r.batch.steps.forEach((s, i) => {
            step_results[i] = null; step_errors[i] = null;
            if (!holds(s.condition, step_results, step_errors)) return;
            try { step_results[i] = execute(s.stmt); } catch (err) { step_errors[i] = { message: err.message }; }
          });
          return { type: 'ok', response: { type: 'batch', result: { step_results, step_errors } } };
        }
        throw new Error('unsupported request ' + r.type);
      } catch (err) {
        return { type: 'error', error: { message: err.message } };
      }
    });
    return new Response(JSON.stringify({ baton: null, base_url: null, results }), { headers: { 'Content-Type': 'application/json' } });
  };
}
