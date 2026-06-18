const { Resend } = require('resend');

let resend = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

async function sendWelcomeEmail(email, naam, customerId) {
  const r = getResend();
  if (!r) return;
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'HomeSeekerBot';

  const { generateStartPayload } = require('./telegram');
  const signedPayload = generateStartPayload(customerId);
  const telegramLink = `https://t.me/${botUsername}?start=${signedPayload}`;

  await r.emails.send({
    from: 'HomeSeeker <support@homeseeker.dev>',
    to: email,
    subject: 'Welcome to HomeSeeker - Activate your Telegram alerts',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#111">
        <h2 style="color:#00c896">Hi ${naam || 'there'} 👋</h2>
        <p>Your 7-day HomeSeeker trial is active. We monitor <strong>Funda, Kamernet, and HousingAnywhere</strong> - 24/7, across 19 Dutch cities. Click the button below to activate your personal Telegram alerts:</p>
        <div style="text-align:center;margin:32px 0">
          <a href="${telegramLink}" style="background:#00c896;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px">
            📱 Activate Telegram Alerts
          </a>
        </div>
        <p><strong>This link is personal</strong> - it securely connects your payment to your Telegram account. Do not share it.</p>
        <ol>
          <li>Click the button above</li>
          <li>Telegram opens the HomeSeeker bot</li>
          <li>Press <strong>Start</strong></li>
          <li>Set your filters and receive real-time alerts</li>
        </ol>
        <p style="color:#666;font-size:13px">Questions? Email us at support@homeseeker.dev</p>
        <p>Good luck with your search! 🏠</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="color:#999;font-size:12px">
          7-day free trial. After your trial, €9,99/month incl. 21% VAT is charged automatically.
          Cancel anytime before day 7 by replying to this email or via /cancel in Telegram.
        </p>
      </div>
    `,
  });
}

module.exports = { sendWelcomeEmail };