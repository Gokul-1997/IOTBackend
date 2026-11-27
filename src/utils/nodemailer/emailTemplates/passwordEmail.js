function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function generatePasswordEmail({ link, email, companyName, setup = false }) {
  const title = setup ? 'Welcome to STM Mexa IoT' : 'Reset your password';
  const action = setup ? 'Set your password' : 'Reset password';
  const expiry = setup ? '24 hours' : '15 minutes';
  const intro = setup
    ? `Your company administrator account for ${companyName} is ready. Set your password to get started.`
    : 'We received a request to reset the password for your STM Mexa IoT account.';
  const note = setup
    ? 'If you were not expecting this invitation, contact your company administrator.'
    : 'If you did not request this change, you can ignore this email. Your password will stay the same.';
  const text = `${title}\n\n${intro}\n\nAccount: ${email}\n\n${action}: ${link}\n\nChoose a new password and enter it again to confirm. This link can be used once and expires in ${expiry}. Never share this link.\n\nIf the link expires, request a new one using Forgot password on the sign-in page.\n\n${note}\n\nSTM Mexa IoT | STM CNC\nThis is an automated account security email.`;
  const safeLink = escapeHtml(link);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f6fa;color:#202124;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(intro)} Your secure link expires in ${expiry}.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6fa;"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e0e4ec;border-radius:12px;">
      <tr><td style="padding:32px 28px 24px;border-bottom:1px solid #edf0f5;">
        <div style="font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#2b3990;">STM <span style="color:#df3d45;">Mexa</span> <span style="font-size:16px;font-weight:400;color:#5f6368;">IoT</span></div>
      </td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 12px;color:#687187;font-size:11px;line-height:16px;letter-spacing:1.6px;font-weight:700;">${setup ? 'YOUR NEW ACCOUNT' : 'ACCOUNT SECURITY'}</p>
        <h1 style="margin:0 0 18px;font-size:25px;line-height:33px;font-weight:600;color:#202124;">${title}</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:25px;color:#4b5563;">${escapeHtml(intro)}</p>
        <p style="margin:0 0 24px;padding:14px 16px;background:#f6f8fc;border-radius:6px;font-size:14px;line-height:22px;overflow-wrap:anywhere;word-break:break-word;"><span style="color:#687187;">Account</span><br><strong style="color:#202124;">${escapeHtml(email)}</strong></p>
        <table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#2b3990" style="border-radius:6px;text-align:center;"><a href="${safeLink}" style="display:inline-block;padding:14px 24px;border:1px solid #2b3990;border-radius:6px;color:#ffffff;font-size:15px;line-height:20px;font-weight:600;text-decoration:none;">${action}</a></td></tr></table>
        <p style="margin:22px 0 8px;font-size:14px;line-height:23px;color:#4b5563;">Choose a new password and enter it again to confirm.</p>
        <p style="margin:0 0 22px;font-size:13px;line-height:22px;color:#687187;">This link can be used once and expires in <strong>${expiry}</strong>. Never share this link.</p>
        <p style="margin:0 0 8px;font-size:12px;line-height:20px;color:#687187;">Button not working? Copy and paste this link into your browser:</p>
        <p style="margin:0 0 22px;word-break:break-all;overflow-wrap:anywhere;font-size:12px;line-height:20px;"><a href="${safeLink}" style="color:#2b3990;text-decoration:underline;word-break:break-all;">${safeLink}</a></p>
        <p style="margin:0 0 14px;font-size:13px;line-height:22px;color:#687187;">If the link expires, request a new one using <strong>Forgot password</strong> on the sign-in page.</p>
        <p style="margin:0;padding-top:18px;border-top:1px solid #edf0f5;font-size:12px;line-height:21px;color:#687187;">${note}</p>
      </td></tr>
    </table>
    <p style="max-width:520px;margin:20px 0 0;font-size:12px;line-height:20px;color:#7b8496;text-align:center;">STM Mexa IoT &bull; STM CNC<br>This is an automated account security email.</p>
  </td></tr></table>
</body></html>`;
  return { html, text };
}

module.exports = { generatePasswordEmail };
