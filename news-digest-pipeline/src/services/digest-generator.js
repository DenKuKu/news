import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  updateArticleStatus,
  updateArticleCommentary,
  createDigest,
  updateDigest,
  assignArticlesToDigest,
  getDigests,
  getDigest,
} from '../db/index.js';
import { priceFor } from '../data/model-catalog.js';
import { callModel, sleep } from './llm.js';

const MAX_CONTENT_LENGTH = 3000;
const INTER_CALL_DELAY_MS = 200;
const ANALYSIS_ATTEMPTS = 2;

const RELATIONS = new Set(['прямая', 'смежная', 'слабая']);
const CONFIDENCE_LEVELS = new Set(['низкая', 'средняя']);

function cleanText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```(?:json)?/gi, ' ')
    .replace(/```/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/texturalab/gi, 'TexturaLab')
    .trim()
    .slice(0, maxLength);
}

function extractJson(rawText) {
  const cleaned = String(rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Модель не вернула JSON-объект');
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ответ модели должен быть JSON-объектом');
  }

  const titleRu = cleanText(value.title_ru, 180);
  const signal = cleanText(value.signal, 500);
  const question = cleanText(value.question, 400);
  const relation = cleanText(value.relation, 30).toLowerCase();
  let confidence = cleanText(value.confidence, 30).toLowerCase();

  const factsSource = Array.isArray(value.facts)
    ? value.facts
    : typeof value.facts === 'string'
      ? [value.facts]
      : [];

  const facts = factsSource
    .map((fact) => cleanText(fact, 350))
    .filter(Boolean)
    .slice(0, 4);

  if (titleRu.length < 3) throw new Error('Пустой title_ru');
  if (facts.length === 0) throw new Error('Пустой массив facts');
  if (signal.length < 8) throw new Error('Пустой signal');
  if (question.length < 8) throw new Error('Пустой question');
  if (!RELATIONS.has(relation)) {
    throw new Error('relation должна быть: прямая, смежная или слабая');
  }

  // RSS-аннотация не даёт основания для высокой уверенности.
  if (confidence === 'высокая') confidence = 'средняя';
  if (!CONFIDENCE_LEVELS.has(confidence)) {
    throw new Error('confidence должна быть: низкая или средняя');
  }

  return {
    title_ru: titleRu,
    facts,
    signal,
    relation,
    confidence,
    question,
  };
}

function parseCardFromCommentary(commentary) {
  return normalizeCard(extractJson(commentary));
}

async function analyzeArticle(article, commentarySystem, config, log) {
  const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);

  const baseUserMessage = [
    `ЗАГОЛОВОК ИСТОЧНИКА: ${article.title || 'не указан'}`,
    '',
    'КРАТКОЕ СОДЕРЖАНИЕ RSS:',
    contentTruncated || 'не предоставлено',
    '',
    'Верни только один валидный JSON-объект без Markdown и пояснений:',
    '{',
    '  "title_ru": "естественный русский заголовок",',
    '  "facts": ["факт 1", "факт 2"],',
    '  "signal": "один осторожный возможный сигнал",',
    '  "relation": "прямая | смежная | слабая",',
    '  "confidence": "низкая | средняя",',
    '  "question": "один конкретный вопрос для проверки"',
    '}',
    '',
    'Не добавляй сведения, которых нет в RSS-аннотации.',
    'Не используй выражения «рост интереса», «растёт спрос», «рынок переходит», «смещение рынка» или «становится трендом».',
  ].join('\n');

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= ANALYSIS_ATTEMPTS; attempt += 1) {
    const userMessage = attempt === 1
      ? baseUserMessage
      : `${baseUserMessage}\n\nПредыдущий ответ не прошёл проверку: ${lastError?.message}. Исправь формат и верни только JSON.`;

    const response = await callModel(config, {
      system: commentarySystem,
      user: userMessage,
      maxTokens: 900,
    });

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    try {
      const card = normalizeCard(extractJson(response.text));
      return { card, totalInputTokens, totalOutputTokens };
    } catch (error) {
      lastError = error;
      log.push(`Article ${article.id}: invalid JSON attempt ${attempt}: ${error.message}`);
    }
  }

  throw lastError || new Error('Не удалось получить валидный JSON');
}

function buildDigest(entries, config) {
 const marker = '#ДайджестTexturaLab';

  const sections = entries.map(({ article, card }, index) => {
    const factLines = card.facts.map((fact) => `- ${fact}`).join('\n');

    return [
      `### ${index + 1}. ${card.title_ru}`,
      '',
      '**Что известно**',
      factLines,
      '',
      '**Возможный сигнал**',
      card.signal,
      '',
      `**Связь с TexturaLab:** ${card.relation}.`,
      `**Уверенность:** ${card.confidence}.`,
      '',
      '**Что стоит проверить**',
      card.question,
      '',
      `Источник: ${article.url}`,
    ].join('\n');
  });

  const ending = [];
  if (cleanText(config.boundaryIntent, 1000)) {
    ending.push(cleanText(config.boundaryIntent, 1000));
  }
  if (cleanText(config.hashtagsSuffix, 1000)) {
    ending.push(cleanText(config.hashtagsSuffix, 1000));
  }

  return [
    marker,
    '',
    'Ниже — подборка отдельных отраслевых сигналов. Она не доказывает сформировавшийся тренд, но показывает темы, которые стоит проверить на других источниках.',
    '',
    ...sections.flatMap((section, index) => (
      index === sections.length - 1 ? [section] : [section, '', '---', '']
    )),
    '',
    '### Общая картина',
    '',
    'Эти материалы относятся к разным участкам мебельного и интерьерного рынка. Для вывода о повторяющейся тенденции нужно сопоставить их с более широкой выборкой источников.',
    '',
    ...ending,
  ].filter((part) => part !== null && part !== undefined).join('\n');
}

export async function generateDigest(db, articles, config) {
  const log = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  log.push(`Starting structured digest generation for ${articles.length} articles`);

  // Автоматически возвращаем в очередь только давно зависшие статьи.
  const recovered = db.prepare(
    `UPDATE articles
     SET status = 'new', updated_at = datetime('now')
     WHERE status = 'processing'
       AND digest_id IS NULL
       AND updated_at < datetime('now', '-30 minutes')`
  ).run().changes;

  if (recovered > 0) {
    log.push(`Recovered stale processing articles: ${recovered}`);
  }

  const scenario = config.activeScenario || 'architect';
  let commentarySystem = scenario === 'architect'
    ? config.deepPrompt
    : config.commentaryPrompt;

  if (!commentarySystem || !commentarySystem.trim()) {
    commentarySystem = [
      '/no_think',
      'Ты — аналитик отраслевых сигналов TexturaLab.',
      'Используй только сведения из входной RSS-аннотации.',
      'Не придумывай отсутствующие факты.',
    ].join('\n');
  }

  const entries = [];

  for (const article of articles) {
    try {
      if (article.commentary) {
        try {
          const card = parseCardFromCommentary(article.commentary);
          entries.push({ article, card });
          log.push(`Reused structured commentary for article ${article.id}`);
          continue;
        } catch {
          // Старый текстовый комментарий или повреждённый JSON — анализируем заново.
        }
      }

      updateArticleStatus(article.id, 'processing');

      const result = await analyzeArticle(article, commentarySystem, config, log);
      totalInputTokens += result.totalInputTokens;
      totalOutputTokens += result.totalOutputTokens;

      const storedJson = JSON.stringify(result.card, null, 2);
      updateArticleCommentary(article.id, storedJson);
      article.commentary = storedJson;

      entries.push({ article, card: result.card });
      log.push(`Generated structured analysis for article ${article.id}`);

      await sleep(INTER_CALL_DELAY_MS);
    } catch (error) {
      log.push(`Error analyzing article ${article.id}: ${error.message}`);
      updateArticleStatus(article.id, 'error');
    }
  }

  if (entries.length === 0) {
    throw new Error('No valid structured article analyses — cannot assemble digest');
  }

  // Финальный текст собирается обычным кодом. Второй вызов модели не используется.
  const digestContent = buildDigest(entries, config);
  const today = new Date().toISOString().slice(0, 10);

  const digestId = createDigest({
    date: today,
    part: 1,
    articlesCount: entries.length,
  });

  const pricing = priceFor(config.claudeModel);
  let costUsd = null;

  if (pricing) {
    const rawCost =
      (totalInputTokens / 1e6) * pricing.input
      + (totalOutputTokens / 1e6) * pricing.output;
    costUsd = Math.round(rawCost * 1e6) / 1e6;
  }

  log.push(
    `Tokens: in=${totalInputTokens} out=${totalOutputTokens} | `
    + `Model: ${config.claudeModel} | deterministic assembly=true`
  );

  updateDigest(digestId, {
    content: digestContent,
    status: 'draft',
    generation_log: log.join('\n'),
    model: config.claudeModel,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: costUsd,
  });

  const articleIds = entries.map(({ article }) => article.id);
  assignArticlesToDigest(articleIds, digestId);

  const filePath = saveDigestToFile(today, digestContent);
  log.push(`Digest saved to file: ${filePath}`);
  log.push(`Digest created: ${digestId}`);

  const saved = getDigest(digestId);
  const digestMarker = '#ДайджестTexturaLab';
  const digestOk = saved
    && typeof saved.content === 'string'
    && saved.content.length > 100
    && saved.content.includes(digestMarker);

  if (!digestOk) {
    log.push('Skipping source cleanup: digest not confirmed valid');
  } else if (config.telegramBotToken) {
    const { deleteTelegramMessage } = await import('./telegram-bot.js');
    const seen = new Set();
    let deleted = 0;
    let failed = 0;

    for (const { article } of entries) {
      if (!article.source_chat_id || !article.source_message_id) continue;
      const key = `${article.source_chat_id}:${article.source_message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const ok = await deleteTelegramMessage(
          config.telegramBotToken,
          article.source_chat_id,
          Number(article.source_message_id)
        );
        if (ok) deleted += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }

    log.push(`Telegram source cleanup: deleted=${deleted}, failed=${failed}`);
  }

  // Записываем финальный лог ещё раз, уже после сохранения файла и cleanup.
  updateDigest(digestId, { generation_log: log.join('\n') });

  return digestId;
}

function saveDigestToFile(date, content) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(__dirname, '../../output');
  mkdirSync(outputDir, { recursive: true });

  const existing = getDigests().filter((digest) => digest.date === date);
  const part = existing.length || 1;

  const filename = `digest_${date}_part${part}.txt`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[digest-generator] Saved digest to ${filePath}`);
  return filePath;
}
