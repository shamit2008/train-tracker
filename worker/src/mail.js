/* Sending email (password-reset links), behind one small interface so the email service can be swapped the
   same way the database can.

   A mailer is any object with:   async send({ to, subject, text, html })

   Settings (wrangler.toml [vars], keys as Worker secrets):
     MAIL_PROVIDER  "resend" (needs RESEND_API_KEY), "brevo" (needs BREVO_API_KEY), or "log" (prints the email to
                    the worker's log instead of sending it: for testing only)
     MAIL_FROM      the sender, as "Trackside <noreply@your-domain.example>"; the provider must allow that address
     MAILER         a mailer object handed in directly (local dev server, tests)
   With none of these, mailerFor() returns null and password reset answers 503. */

const parseFrom = (s) => {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>\s]+@[^>\s]+)>\s*$/.exec(String(s || '')) || /^\s*()([^\s<>]+@[^\s<>]+)\s*$/.exec(String(s || ''));
  return m ? { name: (m[1] || 'Trackside').trim(), email: m[2] } : null;
};

async function post(service, url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`);
}

const ADAPTERS = {
  /* https://resend.com — free for 3,000 emails a month. Sending to anyone needs a domain verified with Resend. */
  resend: (env, from) => env.RESEND_API_KEY && {
    send: (m) => post('Resend', 'https://api.resend.com/emails', { Authorization: 'Bearer ' + env.RESEND_API_KEY },
      { from: `${from.name} <${from.email}>`, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
  },
  /* https://www.brevo.com — free for 300 emails a day. Can send from a single verified address, no domain needed. */
  brevo: (env, from) => env.BREVO_API_KEY && {
    send: (m) => post('Brevo', 'https://api.brevo.com/v3/smtp/email', { 'api-key': env.BREVO_API_KEY },
      { sender: from, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html }),
  },
  log: () => ({
    send: async (m) => console.log(`[mail] to ${m.to}: ${m.subject}\n${m.text}`),
  }),
};

export function mailerFor(env) {
  if (env.MAILER) return env.MAILER;
  const make = ADAPTERS[String(env.MAIL_PROVIDER || '').toLowerCase()];
  const from = parseFrom(env.MAIL_FROM) || (env.MAIL_PROVIDER === 'log' ? { name: 'Trackside', email: 'log@localhost' } : null);
  return (make && from && make(env, from)) || null;
}
