const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendWelcomeEmail(email, naam) {
  const t = getTransporter();
  if (!t) return;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'HomeSeekerBot';
  await t.sendMail({
    from: process.env.FROM_EMAIL || 'HomeSeeker <homeseeker@gmail.com>',
    to: email,
    subject: 'Welcome to HomeSeeker — Set up your alerts',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
        <h2 style="color:#00e5a0">Hi ${naam || 'there'} 👋</h2>
        <p>Your HomeSeeker subscription is active. Here's how to start receiving alerts:</p>
        <ol>
          <li>Open Telegram on your phone</li>
          <li>Search for <strong>@${botUsername}</strong></li>
          <li>Tap <strong>Start</strong> and send the command <code>/start</code></li>
          <li>The bot will send you a personal link to set your filters</li>
        </ol>
        <p>Once your filters are saved, you'll receive real-time alerts for new listings that match your criteria.</p>
        <p style="color:#666;font-size:13px">Questions? Email us at homeseeker@gmail.com</p>
        <p>Good luck with your search! 🏠</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">
          7-day free trial. After your trial, €11.99/month is charged automatically.
          Cancel anytime before the trial ends by replying to this email.
        </p>
      </div>
    `,
  });
}

module.exports = { sendWelcomeEmail };
