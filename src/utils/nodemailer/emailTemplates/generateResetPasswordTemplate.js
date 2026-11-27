const { generatePasswordEmail } = require('./passwordEmail');

function generateResetPasswordEmail(resetLink, userEmail) {
  return generatePasswordEmail({ link: resetLink, email: userEmail });
}

function generateResetPasswordTemplate(resetLink, userEmail) {
  return generateResetPasswordEmail(resetLink, userEmail).html;
}

module.exports = { generateResetPasswordTemplate, generateResetPasswordEmail };
