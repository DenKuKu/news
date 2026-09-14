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

    try {
      const digestId = await generateDigest(db, articles, config);
      log(`Digest created: ${digestId}`);
    } catch (error) {
      db.prepare("UPDATE articles SET status = 'new', updated_at = datetime('now') WHERE status = 'processing' AND digest_id IS NULL").run();
      log(`Digest generation failed: ${error.message}`);
      process.exitCode = 1;
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
