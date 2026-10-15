/* Texting a code to a phone number and checking it, so an account can only claim a number it can receive texts at.

   A verifier is any object with:   async start(phone)   sends a code to phone (E.164)
                                    async check(phone, code) -> boolean

   Settings (wrangler.toml [vars], keys as Worker secrets):
     SMS_PROVIDER  "twilio" (Twilio Verify: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SID), or
                   "log" (prints the code to the worker's log instead of texting it: for testing only)
     SMS           a verifier object handed in directly (tests)
   With none of these, verifierFor() returns null and adding a phone number answers 503.

   Twilio Verify keeps the codes and handles US carrier registration itself, which plain text messages need. */

function twilio(env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SID) return null;
  const base = `https://verify.twilio.com/v2/Services/${encodeURIComponent(env.TWILIO_VERIFY_SID)}`;
  const auth = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const post = (path, fields) => fetch(base + path, {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  });
  return {
    async start(phone) {
      const res = await post('/Verifications', { To: phone, Channel: 'sms' });
      if (!res.ok) throw new Error(`Twilio: HTTP ${res.status}`);
    },
    async check(phone, code) {
      const res = await post('/VerificationCheck', { To: phone, Code: code });
      if (res.status === 404) return false;   // no code pending: expired, used, or never sent
      if (!res.ok) throw new Error(`Twilio: HTTP ${res.status}`);
      return (await res.json()).status === 'approved';
    },
  };
}

/* For the local dev server: codes kept in this process and printed. */
const logged = new Map();
const log = () => ({
  async start(phone) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    logged.set(phone, code);
    console.log(`[sms] code for ${phone}: ${code}`);
  },
  async check(phone, code) {
    if (logged.get(phone) !== code) return false;
    logged.delete(phone);
    return true;
  },
});

export function verifierFor(env) {
  if (env.SMS) return env.SMS;
  const kind = String(env.SMS_PROVIDER || '').toLowerCase();
  return kind === 'twilio' ? twilio(env) : kind === 'log' ? log() : null;
}
