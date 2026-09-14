import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const configuredChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  console.error('Create a bot via @BotFather, then add: TELEGRAM_BOT_TOKEN=...');
  process.exit(1);
}

async function telegram(method, body = null) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram HTTP ${response.status}`);
  }
  return payload.result;
}

try {
  const me = await telegram('getMe');
  console.log(`Bot: @${me.username || me.first_name}`);

  if (configuredChatId) {
    const sent = await telegram('sendMessage', {
      chat_id: configuredChatId,
      text: 'TexturaLab News Agent: Telegram подключён. Следующий созданный дайджест придёт сюда.',
      disable_web_page_preview: true,
    });
    console.log(`Test message sent to TELEGRAM_CHAT_ID=${configuredChatId} (message_id=${sent.message_id})`);
    process.exit(0);
  }

  const updates = await telegram('getUpdates');
  const chats = new Map();
  for (const update of updates) {
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    const chat = message?.chat;
    if (!chat?.id) continue;
    chats.set(String(chat.id), {
      id: String(chat.id),
      type: chat.type || '',
      title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '',
    });
  }

  if (!chats.size) {
    console.log('No chats found yet.');
    console.log(`Open @${me.username || 'your bot'} in Telegram, press Start (or send any message), then run this command again.`);
    process.exit(2);
  }

  console.log('Available chats:');
  for (const chat of chats.values()) {
    console.log(`  ${chat.id}\t${chat.type}\t${chat.title}`);
  }
  console.log('');
  console.log('Add the desired chat to .env, for example:');
  console.log(`TELEGRAM_CHAT_ID=${[...chats.values()][0].id}`);
  console.log('Then run npm run telegram:setup again to send a test message.');
} catch (error) {
  console.error(`Telegram setup failed: ${error.message}`);
  process.exit(1);
}
