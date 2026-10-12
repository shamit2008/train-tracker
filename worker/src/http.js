/* Response helpers shared by the feeds and the accounts API. */
export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || (origin && allowed.includes(origin)) || (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok && origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : allowed.includes('*') ? { 'Access-Control-Allow-Origin': '*' } : {};
}
export const json = (body, req, env, extra = {}, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req, env), ...extra },
});
