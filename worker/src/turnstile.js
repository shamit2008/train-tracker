/* Cloudflare Turnstile: a bot check on sign-up, so the per-address limit can be generous enough for people who share
   an address (a phone network, a campus) without letting a script make accounts by the thousand.

   Settings: TURNSTILE_SECRET_KEY (a Worker secret) turns it on; the site needs the matching site key in
   TURNSTILE_SITE_KEY in index.html. TURNSTILE, a function (token, ip) -> boolean, can be handed in for tests.
   Off, checkHuman() answers null and sign-up keeps the tighter per-address limit. */
export async function checkHuman(env, token, ip) {
  if (env.TURNSTILE) return env.TURNSTILE(token, ip);
  if (!env.TURNSTILE_SECRET_KEY) return null;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip && ip !== 'local') body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!res.ok) throw new Error(`Turnstile: HTTP ${res.status}`);
  return (await res.json()).success === true;
}
