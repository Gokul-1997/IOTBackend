/**
 * One-time code asking a supervisor to authorise a CNC program transfer.
 *
 * The code is shown large and on its own line: the supervisor is standing
 * on the shop floor reading it off a phone, often through a glove or a
 * face shield.
 */
function generateTransferAuthTemplate({
  supervisorName,
  requesterName,
  machineSerial,
  programNames = [],
  code,
  expiresInMinutes
}) {
  const programList = programNames.length
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;">${
        programNames.map(n => `<li style="padding:2px 0;">${n}</li>`).join('')
      }</ul>`
    : '<i>no programs listed</i>';

  return `
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body { font-family: Arial, Helvetica, sans-serif; color: #333; }
          .container { max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
          .header { background-color: #fff4ed; padding: 12px; text-align: center; font-size: 20px; font-weight: bold; color: #9a3412; border-radius: 6px; }
          .code { font-size: 34px; letter-spacing: 10px; font-weight: bold; text-align: center; color: #0a3d62; background: #f0f6ff; padding: 18px; border-radius: 8px; margin: 24px 0; }
          .detail { background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-size: 14px; }
          .warn { font-size: 13px; color: #9a3412; background: #fff4ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 10px 14px; }
          .footer { margin-top: 20px; font-size: 12px; color: #777; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">Program Transfer Authorisation</div>

          <p>Hello ${supervisorName || 'Supervisor'},</p>

          <p>
            <b>${requesterName || 'A user'}</b> is requesting to send a program to
            a machine you supervise. Share this code only if you approve the transfer.
          </p>

          <div class="code">${code}</div>

          <div class="detail">
            <b>Machine:</b> ${machineSerial}<br />
            <b>Program(s):</b>
            ${programList}
          </div>

          <p>This code expires in <b>${expiresInMinutes} minutes</b> and works only for this machine.</p>

          <div class="warn">
            Sending the wrong program to a running machine can crash the spindle or
            scrap the part. Confirm the machine is safe before approving.
            If you did not expect this request, do not share the code.
          </div>

          <div class="footer">
            STM MEXA Platform &middot; automated message, do not reply
          </div>
        </div>
      </body>
    </html>
  `;
}

module.exports = { generateTransferAuthTemplate };
