let _adminBot = null;
function setAdminBot(bot) { _adminBot = bot; }

async function sendAdminAlert(msg) {
  const chatId = process.env.ADMIN_CHAT_ID || '6254873672';
  if (!_adminBot) return;
  try {
    await _adminBot.sendMessage(chatId, `🚨 *HomeSeeker Alert*\n\n${msg}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('[watchdog] Failed to send admin alert:', e.message); }
}

module.exports = { setAdminBot, sendAdminAlert };
