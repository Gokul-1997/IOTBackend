# Account setup and password recovery

Creating a company sends its administrator a **Set your password** invitation.
The recipient opens the link, enters a new password and confirms it, then signs
in. The invitation expires after 24 hours. Forgot password sends a reset link
that expires after 15 minutes; it also replaces an expired invitation.

Both emails use the STM Mexa IoT sender name, HTML and plain-text versions,
and the same branded layout. Company creation reports SMTP acceptance as
`welcome_email: sent`, `failed` or `unknown` (after a 20-second wait).
Acceptance by SMTP does not guarantee inbox delivery.

Only SHA-256 token hashes are saved in the existing `password_reset_tokens`
table. Tokens are issued inside a transaction; company creation rolls back if
its invitation cannot be saved. Issuing another link invalidates previous
links. Successful redemption consumes all outstanding links, updates the
password and authorization revision, and revokes existing sessions in one
transaction. Per-account transaction locks serialize issue/redeem requests.
Opening a link does not consume it; submitting the new password does.
No database migration is required.

## Configuration

Set `PUBLIC_FRONTEND_URL=https://stmmexa.stmcnc.com` (or the installation's
canonical HTTPS application URL). This must be one URL, not the browser CORS
allowlist. `FRONTEND_URL` remains supported; legacy comma-separated values
select a valid public HTTPS site, preferring the STM Mexa production site.
Localhost HTTP is accepted only outside production. Invalid explicit public
URLs fail before company creation. Browser allowlists belong in `CORS_ORIGINS`.

`EMAIL_USER` and `EMAIL_PASS` authenticate the existing Gmail SMTP transport.
Use a valid Gmail app password in the server's secret environment; never commit
it or put it in a support message. The sender display name is **STM Mexa IoT**;
the sender address remains the authenticated mailbox.

After updating the server environment and API code, restart its configured PM2
process with `--update-env`. Deploy the frontend production build as well.
Run `node scripts/email-check.js` from the API folder to verify SMTP login
without sending a message. Error `535` means Gmail rejected authentication.
The script's optional `--to` flag sends an actual message, so use it only with
explicit authorization.

## Verification

Backend tests mock the database and mail transport. Browser tests in
`FrontendIOT/e2e/password-setup.spec.ts` stub every API call and cover matching
passwords, setup/reset wording, duplicate submissions, expired-link recovery,
forgot password and phone layout. No customer account or password is changed
by these tests.
