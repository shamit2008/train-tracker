/* SQL client for Cloudflare D1, through the worker's DB binding (see wrangler.toml). */
export function d1Client(db) {
  const stmt = (sql, params = []) => db.prepare(sql).bind(...params);
  return {
    async all(sql, params) { return (await stmt(sql, params).all()).results || []; },
    async run(sql, params) { const r = await stmt(sql, params).run(); return { changes: (r.meta && r.meta.changes) || 0 }; },
    async batch(list) { await db.batch(list.map((s) => stmt(s.sql, s.params))); },   // D1 runs a batch as one transaction
  };
}
