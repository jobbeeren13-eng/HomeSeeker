const { Resend } = require('resend');

let resend = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const WRAP = 'font-family:sans-serif;max-width:580px;margin:0 auto;background:#0a0a0a;color:#e8edf3;padding:32px 28px;border-radius:12px';
const MUTED = 'color:#7a8494';
const GREEN = '#00c896';
const CARD = 'background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:18px 20px;margin:10px 0';
const DIVIDER = 'border:none;border-top:1px solid rgba(255,255,255,0.07);margin:24px 0';

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
      <div style="${WRAP}">
        <p style="font-size:20px;font-weight:800;color:${GREEN};letter-spacing:1px;margin-bottom:20px">HOMESEEKER</p>
        <h2 style="font-size:19px;font-weight:700;margin-bottom:14px;color:#fff">Hi ${naam || 'there'}, your 7-day trial is live.</h2>
        <p style="${MUTED};font-size:14px;line-height:1.7;margin-bottom:24px">We monitor Funda, Kamernet, and HousingAnywhere — 24/7, across 19 Dutch cities. You'll get a personal Telegram alert the moment a matching listing goes live.</p>

        <div style="text-align:center;margin-bottom:28px">
          <a href="${telegramLink}" style="background:${GREEN};color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Activate Telegram Alerts</a>
        </div>

        <p style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${GREEN};margin-bottom:10px">Getting started — 3 steps</p>

        <div style="${CARD};border-top:2px solid ${GREEN}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">1. Set your filters</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">Click the button above to open Telegram. Press Start, then follow the link to set your city, budget, income, and availability. Takes 2 minutes.</p>
        </div>
        <div style="${CARD}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">2. Wait for your first alert</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">Every alert includes your personal Application Score, Market Value Score, landlord tips specific to that listing, and a one-tap AI letter button.</p>
        </div>
        <div style="${CARD}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">3. Use the AI Rental Assistant</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">Each alert links directly to Scout — your AI assistant. Scout analyses the listing, writes your application letter, prepares you for the viewing, and gives you word-for-word negotiation scripts. All specific to this listing.</p>
        </div>

        <hr style="${DIVIDER}">
        <p style="${MUTED};font-size:12px;line-height:1.7">
          <strong style="color:#fff">This link is personal</strong> — it securely connects your payment to your Telegram account. Do not share it.<br><br>
          7-day free trial. After your trial, 9,99 euros per month including 21% VAT is charged automatically. Cancel anytime before day 7 via /cancel in Telegram or by replying to this email. Questions? support@homeseeker.dev
        </p>
      </div>
    `,
  });
}

async function sendTrialReminderEmail(email, naam) {
  const r = getResend();
  if (!r) return;
  await r.emails.send({
    from: 'HomeSeeker <support@homeseeker.dev>',
    to: email,
    subject: 'Your HomeSeeker trial ends in 2 days',
    html: `
      <div style="${WRAP}">
        <p style="font-size:20px;font-weight:800;color:${GREEN};letter-spacing:1px;margin-bottom:20px">HOMESEEKER</p>
        <h2 style="font-size:19px;font-weight:700;margin-bottom:14px;color:#fff">Your trial ends in 2 days.</h2>
        <p style="${MUTED};font-size:14px;line-height:1.7;margin-bottom:24px">Your 7-day free trial ends on day 7. After that, 9,99 euros per month including 21% VAT is charged automatically. Cancel before day 7 and you will not be charged.</p>

        <div style="${CARD};border-top:2px solid ${GREEN}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">Already set up and receiving alerts?</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">No action needed. Your subscription continues automatically and you keep full access to all alerts and AI tools.</p>
        </div>
        <div style="${CARD}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">Want to cancel?</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">Send /cancel to the HomeSeeker bot in Telegram, or reply to this email. Cancel before day 7 and you pay nothing.</p>
        </div>

        <hr style="${DIVIDER}">
        <p style="${MUTED};font-size:12px;line-height:1.7">
          9,99 euros per month including 21% VAT. Cancel anytime. Questions? support@homeseeker.dev
        </p>
      </div>
    `,
  });
}

async function sendCancellationEmail(email, naam) {
  const r = getResend();
  if (!r) return;
  await r.emails.send({
    from: 'HomeSeeker <support@homeseeker.dev>',
    to: email,
    subject: 'Your HomeSeeker subscription has been cancelled',
    html: `
      <div style="${WRAP}">
        <p style="font-size:20px;font-weight:800;color:${GREEN};letter-spacing:1px;margin-bottom:20px">HOMESEEKER</p>
        <h2 style="font-size:19px;font-weight:700;margin-bottom:14px;color:#fff">Your subscription has been cancelled.</h2>
        <p style="${MUTED};font-size:14px;line-height:1.7;margin-bottom:24px">Your HomeSeeker access has ended. You will no longer receive alerts or have access to the AI tools.</p>

        <div style="${CARD};border-top:2px solid ${GREEN}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">Changed your mind?</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">You can restart at any time at <a href="https://homeseeker.dev" style="color:${GREEN};text-decoration:none">homeseeker.dev</a>. A new 7-day trial is available — it takes less than a minute to set up.</p>
        </div>

        <div style="text-align:center;margin:28px 0">
          <a href="https://homeseeker.dev" style="background:${GREEN};color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block">Return to HomeSeeker</a>
        </div>

        <div style="${CARD}">
          <p style="font-size:13px;font-weight:700;color:#fff;margin-bottom:4px">Feedback?</p>
          <p style="${MUTED};font-size:13px;line-height:1.6;margin:0">If something did not work as expected, we want to know. Reply to this email and we will read it.</p>
        </div>

        <hr style="${DIVIDER}">
        <p style="${MUTED};font-size:12px;line-height:1.7">
          Questions? Contact us at support@homeseeker.dev
        </p>
      </div>
    `,
  });
}

module.exports = { sendWelcomeEmail, sendTrialReminderEmail, sendCancellationEmail };
