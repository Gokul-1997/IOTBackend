function generateResetPasswordTemplate(resetLink, userEmail) {
  return `
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          body {
            font-family: Arial, sans-serif;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: auto;
            padding: 20px;
            border: 1px solid #ddd;
            border-radius: 8px;
          }
          .header {
            background-color: #f0f6ff;
            padding: 12px;
            text-align: center;
            font-size: 22px;
            font-weight: bold;
            color: #0a3d62;
          }
          .btn {
            display: block;
            width: fit-content;
            margin: 25px auto;
            padding: 12px 20px;
            background-color: #1976d2;
            color: #fff;
            text-decoration: none;
            border-radius: 6px;
            font-size: 16px;
          }
          .footer {
            margin-top: 20px;
            font-size: 13px;
            color: #777;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">Reset Your Password</div>

          <p>Hello ${userEmail},</p>

          <p>You requested to reset your password. Click the button below to continue.</p>

          <a class="btn" href="${resetLink}">Reset Password</a>

          <p>This link is valid for <b>15 minutes</b>.</p>
          <p>If you did not request this, you can safely ignore this email.</p>

          <div class="footer">
            © Kovai's Brew Cafe / Factory MES
          </div>
        </div>
      </body>
    </html>`;
}

module.exports = { generateResetPasswordTemplate };
