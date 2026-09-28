import http from 'node:http';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const host = String(process.env.RELAY_HOST || '127.0.0.1').trim();
const port = Number.parseInt(process.env.RELAY_PORT || '3001', 10);
const relaySecret = String(process.env.RELAY_SECRET || '').trim();
const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = String(
  process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_PUBLISH_CHAT_ID || '',
).trim();
const stateFile = String(
  process.env.RELAY_STATE_FILE || '/var/lib/texturalab-telegram-relay/idempotency.json',
).trim();
const maxBodyBytes = 256 * 1024;
const telegramTimeoutMs = 20_000;

if (!relaySecret || !botToken || !chatId) {
  console.error(
    '[telegram-relay] RELAY_SECRET, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.',
  );
  process.exit(1);
}

function log(message) {
  console.log(`[telegram-relay] ${new Date().toISOString()} ${message}`);
}

function loadState() {
  if (!existsSync(stateFile)) return {};
  const raw = readFileSync(stateFile, 'utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const state = loadState();
mkdirSync(dirname(stateFile), { recursive: true });

function saveState() {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, stateFile);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const supplied = String(req.headers.authorization || '');
  return safeEqual(supplied, `Bearer ${relaySecret}`);
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    const error = new Error('invalid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function normalizeDigest(body) {
  const digestId = String(body?.digestId || '').trim();
  const text = String(body?.text || '').trim();

  if (!digestId || digestId.length > 160) {
    const error = new Error('invalid digestId');
    error.statusCode = 400;
    throw error;
  }
  if (!text) {
    const error = new Error('text is required');
    error.statusCode = 400;
    throw error;
  }

  return {
    digestId,
    text,
    seqNumber: body?.seqNumber ?? null,
    date: body?.date ?? null,
    articlesCount: body?.articlesCount ?? null,
  };
}

function digestHash(digest) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(digest))
    .digest('hex');
}

function splitTelegramText(text, maxLength = 3900) {
  const source = String(text || '').trim();
  if (!source) return [];

  const chunks = [];
  let rest = source;

  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n\n', maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf('\n', maxLength);
    if (cut < Math.floor(maxLength * 0.55)) cut = rest.lastIndexOf(' ', maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

function buildTelegramText(digest) {
  const header = [
    'TexturaLab — новый рыночный дайджест',
    digest.seqNumber ? `Дайджест #${digest.seqNumber}` : null,
    digest.date ? `Дата: ${digest.date}` : null,
    digest.articlesCount ? `Материалов: ${digest.articlesCount}` : null,
  ].filter(Boolean).join('\n');

  return `${header}\n\n${digest.text}`;
}

async function sendTelegram(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), telegramTimeoutMs);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.description || `Telegram HTTP ${response.status}`);
    }

    const messageId = payload?.result?.message_id;
    if (messageId == null) {
      throw new Error('Telegram returned success without message_id');
    }

    return String(messageId);
  } finally {
    clearTimeout(timer);
  }
}

const inFlight = new Map();

async function deliverDigest(digest) {
  const id = digest.digestId;
  if (inFlight.has(id)) return inFlight.get(id);

  const promise = deliverDigestUnlocked(digest).finally(() => {
    inFlight.delete(id);
  });

  inFlight.set(id, promise);
  return promise;
}

async function deliverDigestUnlocked(digest) {
  const payloadHash = digestHash(digest);
  const existing = state[digest.digestId];

  if (existing && existing.payloadHash !== payloadHash) {
    const error = new Error('digestId already exists with different content');
    error.statusCode = 409;
    throw error;
  }

  if (existing?.completed) {
    return {
      telegramMessageId: existing.messageIds?.[0] || null,
      messageCount: existing.messageIds?.length || 0,
      duplicate: true,
    };
  }

  const chunks = splitTelegramText(buildTelegramText(digest));
  if (!chunks.length) {
    const error = new Error('digest produced no Telegram messages');
    error.statusCode = 400;
    throw error;
  }

  const entry = existing || {
    payloadHash,
    messageIds: [],
    completed: false,
    createdAt: new Date().toISOString(),
  };

  state[digest.digestId] = entry;
  saveState();

  // Persist after every successful chunk. If the relay restarts between chunks,
  // a retry resumes from the first chunk not recorded in the state file.
  for (let i = entry.messageIds.length; i < chunks.length; i += 1) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : '';
    const messageId = await sendTelegram(`${prefix}${chunks[i]}`);
    entry.messageIds.push(messageId);
    entry.updatedAt = new Date().toISOString();
    saveState();
  }

  entry.completed = true;
  entry.completedAt = new Date().toISOString();
  saveState();

  return {
    telegramMessageId: entry.messageIds[0],
    messageCount: entry.messageIds.length,
    duplicate: false,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return writeJson(res, 200, { ok: true });
    }

    if (req.url !== '/telegram/digest') {
      return writeJson(res, 404, { ok: false, error: 'not found' });
    }

    if (req.method !== 'POST') {
      return writeJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (!isAuthorized(req)) {
      return writeJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    const body = await readJson(req);
    const digest = normalizeDigest(body);
    const result = await deliverDigest(digest);

    log(
      `delivered digest=${digest.digestId} messages=${result.messageCount} duplicate=${result.duplicate}`,
    );

    return writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    log(`request failed: ${error.message}`);
    return writeJson(res, status, { ok: false, error: error.message });
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

server.listen(port, host, () => {
  log(`listening on http://${host}:${port}`);
});
