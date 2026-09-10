const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});


async function sendEmail({ to, subject, html, text, attachments = [] }) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to,
      subject,
      html,
      text,
      attachments
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${to}: ${info.response}`);
    return info.response;
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    throw error;
  }
}


async function sendBulkEmails({ recipients = [], subject, html, text, attachments = [] }) {
  return Promise.all(
    recipients.map(async (email) => {
      try {
        const response = await sendEmail({ to: email, subject, html, text, attachments });
        return { email, status: 'fulfilled', response };
      } catch (error) {
        return { email, status: 'rejected', error: error.message };
      }
    })
  );
}

module.exports = {
  sendEmail,
  sendBulkEmails
};
