/* SQL client for Turso (libSQL), over its HTTP pipeline API (Hrana v2), so it runs in a worker without a driver.
   url: the database URL (libsql://name-org.turso.io or https://…); token: a database auth token. */
export function tursoClient(url, token) {
  const endpoint = String(url).replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '') + '/v2/pipeline';
  const arg = (v) => (v == null ? { type: 'null' }
    : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) });
  const cell = (c) => (c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.value);
  const stmt = (s) => ({ sql: s.sql, args: (s.params || []).map(arg) });

  async function send(request) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [request, { type: 'close' }] }),
    });
    if (!res.ok) throw new Error(`Turso: HTTP ${res.status}`);
    const r = (await res.json()).results[0];
    if (r.type !== 'ok') throw new Error('Turso: ' + ((r.error && r.error.message) || 'request failed'));
    return r.response;
  }
  const execute = async (sql, params) => (await send({ type: 'execute', stmt: stmt({ sql, params }) })).result;

  return {
    async all(sql, params) {
      const r = await execute(sql, params);
      return r.rows.map((row) => Object.fromEntries(r.cols.map((c, i) => [c.name, cell(row[i])])));
    },
    async run(sql, params) {
      return { changes: (await execute(sql, params)).affected_row_count || 0 };
    },
    /* All or nothing: each step runs only if the one before it succeeded, and a failure rolls back. */
    async batch(list) {
      const steps = [{ stmt: { sql: 'BEGIN' } }];
      for (const s of list) steps.push({ condition: { type: 'ok', step: steps.length - 1 }, stmt: stmt(s) });
      const commit = steps.length;
      steps.push({ condition: { type: 'ok', step: commit - 1 }, stmt: { sql: 'COMMIT' } });
      steps.push({ condition: { type: 'not', cond: { type: 'ok', step: commit } }, stmt: { sql: 'ROLLBACK' } });
      const { result } = await send({ type: 'batch', batch: { steps } });
      const err = result.step_errors.slice(0, commit + 1).find(Boolean);
      if (err || !result.step_results[commit]) throw new Error('Turso: ' + ((err && err.message) || 'batch failed'));
    },
  };
}
