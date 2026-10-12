/* SQL client on Node's built-in SQLite (node:sqlite, Node 22.5 or later), for the local dev server and tests.
   Lives outside src/ so it's never bundled into the Cloudflare worker. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/* file: a path, or ':memory:'. Applies every migration on open; they're written to be safe to re-run. */
export function sqliteClient(file = ':memory:') {
  const db = new DatabaseSync(file);
  for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  return {
    async all(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
    async run(sql, params = []) { return { changes: Number(db.prepare(sql).run(...params).changes) }; },
    async batch(list) {
      db.exec('BEGIN');
      try {
        for (const s of list) db.prepare(s.sql).run(...(s.params || []));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close() { db.close(); },
  };
}
