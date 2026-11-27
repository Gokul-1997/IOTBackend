#!/usr/bin/env node
/*
 * Can this server send email — password resets, a new company admin's
 * welcome with their password, emailed reports, alarm emails?
 *
 *   cd <the API folder> && node scripts/email-check.js
 *   cd <the API folder> && node scripts/email-check.js --to you@example.com   (also sends one test email)
 *
 * Reads the API's .env and signs in to the mail server (smtp.gmail.com) as
 * EMAIL_USER with EMAIL_PASS. It prints the address and the password's
 * length — never the password — and, when the server refuses, what to do
 * (27 Nov 2026: "535-5.7.8 Username and Password not accepted": Gmail takes
 * only an app password from a server). It touches no database.
 */
const path = require('path');

const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';

const HINTS = [
  [/\b53[45]\b|BadCredentials|Username and Password not accepted|Application-specific password|EAUTH/i, [
    'Gmail refused the address and password. From a server, Gmail accepts only an app password:',
    `  1. Sign in to the Google account of EMAIL_USER and turn on 2-Step Verification (Google Account → Security).`,
    `  2. Create an app password at ${APP_PASSWORDS} (name it "MEXA server").`,
    '  3. Put its 16 letters in .env as EMAIL_PASS — no spaces, no quotes. Keep EMAIL_USER the full Gmail address.',
    '  Changing the Google password deletes the app passwords: after a password change, make a new one.',
    'Then restart the API (pm2 restart iot-app --update-env) and run this check again.'
  ]],
  [/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ESOCKET|ENOTFOUND|ECONNECTION|timed? ?out/i, [
    'The mail server could not be reached (smtp.gmail.com, port 465). The server\'s firewall or the',
    'hosting provider may block outgoing mail: allow outgoing TCP 465, then run this check again.'
  ]]
];

/** The flags this script takes. */
function optionsOf(args) {
  const i = args.indexOf('--to');
  return { to: i >= 0 ? args[i + 1] || null : null };
}

async function main({ env = process.env, mailer = () => require('../src/utils/nodemailer'), to = null } = {}) {
  const user = String(env.EMAIL_USER || '').trim();
  const pass = String(env.EMAIL_PASS || '');
  console.log(`EMAIL_USER: ${user || '(not set)'}`);
  console.log(`EMAIL_PASS: ${pass ? `set, ${pass.length} characters` : '(not set)'}`);
  if (!user || !pass) {
    console.log('FAILED: EMAIL_USER and EMAIL_PASS must both be set in .env (the Gmail address, and its app password).');
    return 1;
  }
  if (/\s/.test(pass)) console.log('Note: EMAIL_PASS contains spaces — write the app password without them.');

  try {
    await mailer().verify();
  } catch (err) {
    const reason = String(err?.message || err).replace(/\s+/g, ' ').trim();
    console.log(`FAILED: ${reason.slice(0, 300)}`);
    const hint = HINTS.find(([pattern]) => pattern.test(`${err?.code || ''} ${reason}`));
    if (hint) for (const line of hint[1]) console.log(line);
    if (hint === HINTS[0] && /@(gmail|googlemail)\.com$/i.test(user) && pass.replace(/\s/g, '').length !== 16) {
      console.log(`(EMAIL_PASS has ${pass.replace(/\s/g, '').length} letters; a Gmail app password has 16 — this looks like the account's own password.)`);
    }
    return 1;
  }
  console.log('OK: the mail server accepted the sign-in.');

  if (to) {
    try {
      await mailer().sendEmail({ to, subject: 'STM MEXA — test email',
        text: 'This server can send email: password resets, welcome emails and reports will arrive.' });
      console.log(`OK: a test email was sent to ${to}.`);
    } catch (err) {
      console.log(`FAILED to send to ${to}: ${String(err?.message || err).slice(0, 300)}`);
      return 1;
    }
  }
  return 0;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  main(optionsOf(process.argv.slice(2))).then(code => process.exit(code), err => { console.log(`FAILED: ${err.message}`); process.exit(1); });
}

module.exports = { main, optionsOf, HINTS };
