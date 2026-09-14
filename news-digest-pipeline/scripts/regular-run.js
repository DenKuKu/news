import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, '..');
process.chdir(projectDir);

const lockPath = join(projectDir, 'data', 'regular-run.lock');
mkdirSync(join(projectDir, 'data'), { recursive: true });
mkdirSync(join(projectDir, 'output'), { recursive: true });

function log(message) {
  const line = `[regular-run] ${new Date().toISOString()} ${message}`;
  console.log(line);
}

function acquireLock() {
  if (existsSync(lockPath)) {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (ageMs < 4 * 60 * 60 * 1000) return null;
      unlinkSync(lockPath);
    } catch {}
  }
  try {
    return openSync(lockPath, 'wx');
  } catch {
    return null;
  }
}

async function localModelAvailable(config) {
  if (config.llmVendor !== 'openai') return true;
  const base = String(config.openaiBaseUrl || '').trim();
  if (!base || !/(localhost|127\.0\.0\.1)/i.test(base)) return true;
  const url = `${base.replace(/\/$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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

async function sendTelegramDigest(config, dbModule, digestId) {
  const token = String(config.telegramBotToken || '').trim();
  const chatId = String(config.telegramChatId || config.telegramPublishChatId || '').trim();

  if (!token || !chatId) {
    log('Telegram delivery is not configured; digest remains available in the web UI.');
    return;
  }

  const digest = dbModule.getDigest(digestId);
  if (!digest?.content?.trim()) {
    log(`Telegram delivery skipped: digest ${digestId} has no content.`);
    return;
  }

  const header = [
    'TexturaLab — новый рыночный дайджест',
    digest.seq_number ? `Дайджест #${digest.seq_number}` : null,
    digest.date ? `Дата: ${digest.date}` : null,
    digest.articles_count ? `Материалов: ${digest.articles_count}` : null,
  ].filter(Boolean).join('\n');

  const chunks = splitTelegramText(`${header}\n\n${digest.content}`);
  let firstMessageId = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : '';
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${prefix}${chunks[i]}`,
        disable_web_page_preview: true,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.description || `Telegram HTTP ${response.status}`);
    }
    if (firstMessageId === null) firstMessageId = payload?.result?.message_id || null;
  }

  if (firstMessageId !== null) {
    dbModule.updateDigest(digestId, { telegram_message_id: String(firstMessageId) });
  }
  log(`Telegram delivery complete: digest=${digestId}, messages=${chunks.length}`);
}

async function main() {
  const lockFd = acquireLock();
  if (lockFd === null) {
    log('Another regular run is active; exiting.');
    return;
  }

  try {
    const sourcesFile = join(__dirname, 'rss-sources.txt');
    const sources = readFileSync(sourcesFile, 'utf-8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    log(`Importing ${sources.length} RSS sources`);
    let importFailures = 0;
    for (const source of sources) {
      const result = spawnSync(process.execPath, [join(__dirname, 'import-rss.js'), source, '25'], {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.stdout?.trim()) process.stdout.write(result.stdout);
      if (result.stderr?.trim()) process.stderr.write(result.stderr);
      if (result.status !== 0) {
        importFailures += 1;
        log(`Import failed for ${source} with exit code ${result.status}`);
      }
    }

    const [{ default: config }, dbModule, { generateDigest }] = await Promise.all([
      import('../src/config.js'),
      import('../src/db/index.js'),
      import('../src/services/digest-generator.js'),
    ]);

    const db = dbModule.initDb(config.dbPath);
    const newCount = db.prepare("SELECT COUNT(*) AS count FROM articles WHERE status = 'new' AND digest_id IS NULL").get().count;
    const minArticles = Math.max(1, Number.parseInt(process.env.REGULAR_DIGEST_MIN_ARTICLES || '5', 10) || 5);

    log(`RSS import complete: failures=${importFailures}, queued_new=${newCount}, threshold=${minArticles}`);

    if (newCount < minArticles) {
      log(`Not enough new articles yet; keeping queue for the next run.`);
      return;
    }

    if (!(await localModelAvailable(config))) {
      log('Local LLM endpoint is unavailable; leaving articles in queue.');
      return;
    }

    const articles = dbModule.getNewArticles(config.maxArticlesPerDigest);
    if (!articles.length) {
      log('No articles available after queue check.');
      return;
    }

    let digestId;
    try {
      digestId = await generateDigest(db, articles, config);
      log(`Digest created: ${digestId}`);
    } catch (error) {
      db.prepare("UPDATE articles SET status = 'new', updated_at = datetime('now') WHERE status = 'processing' AND digest_id IS NULL").run();
      log(`Digest generation failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    try {
      await sendTelegramDigest(config, dbModule, digestId);
    } catch (error) {
      log(`Telegram delivery failed: ${error.message}`);
    }
  } finally {
    try { closeSync(lockFd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
