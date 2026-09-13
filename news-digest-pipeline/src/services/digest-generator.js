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
const MIN_RELEVANCE_SCORE = 55;
const MAX_ACTIONS = 5;

const RELATIONS = new Set(['прямая', 'смежная', 'слабая']);
const CONFIDENCE_LEVELS = new Set(['низкая', 'средняя']);
const CATEGORIES = new Set([
  'production',
  'print-business',
  'design-trends',
  'furniture-market',
  'new-niches',
  'other',
]);

const CATEGORY_LABELS = {
  production: 'Производство, отделка и технологии',
  'print-business': 'Цифровая печать и бизнес-модели',
  'design-trends': 'Принты и интерьерные тренды',
  'furniture-market': 'Мебельный рынок',
  'new-niches': 'Новые ниши и применения',
  other: 'Другие сигналы',
};

const CATEGORY_ORDER = [
  'production',
  'print-business',
  'design-trends',
  'furniture-market',
  'new-niches',
  'other',
];

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

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error('relevance_score должен быть числом от 0 до 100');
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ответ модели должен быть JSON-объектом');
  }

  const titleRu = cleanText(value.title_ru, 180);
  const signal = cleanText(value.signal, 500);
  const action = cleanText(value.action, 500);
  const question = cleanText(value.question, 400);
  const relation = cleanText(value.relation, 30).toLowerCase();
  const category = cleanText(value.category, 40).toLowerCase();
  const relevanceScore = normalizeScore(value.relevance_score);
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
  if (action.length < 8) throw new Error('Пустой action');
  if (question.length < 8) throw new Error('Пустой question');
  if (!RELATIONS.has(relation)) {
    throw new Error('relation должна быть: прямая, смежная или слабая');
  }
  if (!CATEGORIES.has(category)) {
    throw new Error(`Неизвестная category: ${category}`);
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
    relevance_score: relevanceScore,
    category,
    action,
    question,
  };
}

function parseCardFromCommentary(commentary) {
  return normalizeCard(extractJson(commentary));
}

async function analyzeArticle(article, commentarySystem, config, log) {
  const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);

  const baseUserMessage = [
    'КОНТЕКСТ TEXTURALAB:',
    '- B2B-компания для мебельных фабрик, декораторов и интерьерных студий.',
    '- Ключевой приоритет: цифровая сублимационная печать по полиэстеровым мебельным тканям, короткие серии и дизайн по запросу.',
    '- Дополнительные интересы: окрашивание, отделка и пропитка полиэстера; оборудование для текстильной обработки; новые применения интерьерного текстиля.',
    '- Нужны не общие новости, а сигналы, способные повлиять на продукт, технологию, продажи, позиционирование или выбор ниши.',
    '',
    `ЗАГОЛОВОК ИСТОЧНИКА: ${article.title || 'не указан'}`,
    '',
    'КРАТКОЕ СОДЕРЖАНИЕ RSS:',
    contentTruncated || 'не предоставлено',
    '',
    'Оцени материал именно с точки зрения практической пользы для TexturaLab.',
    'Шкала relevance_score:',
    '- 85-100: прямой и сильный сигнал; может изменить решение, технологию, продукт или продажи.',
    '- 70-84: полезный сигнал; стоит учитывать или проверить.',
    '- 55-69: умеренно полезный; можно оставить в дайджесте, если есть конкретный вывод.',
    '- 30-54: слабая связь; обычно не показывать владельцу.',
    '- 0-29: шум или почти не относится к задачам TexturaLab.',
    '',
    'Не завышай оценку только потому, что в тексте встречаются слова textile, design, print, furniture или polyester.',
    'Пример слабого сигнала: арт-объект, выставочная инсталляция или корпоративная новость без понятного применения для TexturaLab.',
    'Пример сильного сигнала: новая технология печати/отделки, химия для текстиля, оборудование, on-demand модель, повторяющийся интерьерный тренд с применением к принтам.',
    '',
    'Категории:',
    '- production: окрашивание, отделка, пропитка, химия, оборудование, автоматизация, термообработка.',
    '- print-business: цифровая печать, on-demand, короткие серии, персонализация, экономика печати.',
    '- design-trends: принты, паттерны, цвета, интерьерные и текстильные тренды.',
    '- furniture-market: мебельные фабрики, обивка, продуктовые изменения на мебельном рынке.',
    '- new-niches: новые применения ткани вне основного мебельного рынка.',
    '- other: всё остальное.',
    '',
    'Верни только один валидный JSON-объект без Markdown и пояснений:',
    '{',
    '  "title_ru": "естественный русский заголовок",',
    '  "facts": ["факт 1", "факт 2"],',
    '  "signal": "что именно это может означать для TexturaLab, без общих фраз",',
    '  "relation": "прямая | смежная | слабая",',
    '  "confidence": "низкая | средняя",',
    '  "relevance_score": 0,',
    '  "category": "production | print-business | design-trends | furniture-market | new-niches | other",',
    '  "action": "одно конкретное действие или гипотеза для TexturaLab; если пользы почти нет, так и напиши",',
    '  "question": "один конкретный вопрос для проверки"',
    '}',
    '',
    'Не добавляй сведения, которых нет в RSS-аннотации.',
    'Не используй выражения «рост интереса», «растёт спрос», «рынок переходит», «смещение рынка» или «становится трендом», если этого прямо не подтверждает источник.',
    'Не придумывай технологическую связь. Если оборудование относится к отделке, не называй его оборудованием цифровой печати.',
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
      maxTokens: 1100,
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

function renderEntry({ article, card }) {
  const factLines = card.facts.map((fact) => `- ${fact}`).join('\n');

  return [
    `#### ${card.title_ru}`,
    '',
    `**Полезность для TexturaLab:** ${card.relevance_score}/100 · ${card.relation} связь · уверенность ${card.confidence}`,
    '',
    '**Что известно**',
    factLines,
    '',
    '**Почему это важно**',
    card.signal,
    '',
    '**Что делать / проверить**',
    card.action,
    '',
    `Контрольный вопрос: ${card.question}`,
    '',
    `Источник: ${(article.source || '').replace(/^rss:/, '').replace(/^www\./, '')}`,
    `Читать оригинал: ${article.url}`,
  ].join('\n');
}

function buildDigest(entries, config, skippedCount = 0) {
  const marker = '#ДайджестTexturaLab';
  const sorted = [...entries].sort((a, b) => b.card.relevance_score - a.card.relevance_score);
  const groupedSections = [];

  for (const category of CATEGORY_ORDER) {
    const categoryEntries = sorted.filter(({ card }) => card.category === category);
    if (categoryEntries.length === 0) continue;

    groupedSections.push([
      `### ${CATEGORY_LABELS[category]}`,
      '',
      ...categoryEntries.flatMap((entry, index) => (
        index === categoryEntries.length - 1
          ? [renderEntry(entry)]
          : [renderEntry(entry), '', '---', '']
      )),
    ].join('\n'));
  }

  const actions = [];
  const seenActions = new Set();
  for (const { card } of sorted) {
    const action = cleanText(card.action, 500);
    const key = action.toLowerCase();
    if (!action || seenActions.has(key)) continue;
    seenActions.add(key);
    actions.push(action);
    if (actions.length >= MAX_ACTIONS) break;
  }

  const actionLines = actions.length > 0
    ? actions.map((action, index) => `${index + 1}. ${action}`).join('\n')
    : 'Нет действий, которые можно обосновать текущими RSS-аннотациями.';

  const ending = [];
  if (cleanText(config.boundaryIntent, 1000)) {
    ending.push(cleanText(config.boundaryIntent, 1000));
  }
  if (cleanText(config.hashtagsSuffix, 1000)) {
    ending.push(cleanText(config.hashtagsSuffix, 1000));
  }

  const filterNote = skippedCount > 0
    ? `Из исходной очереди не показано слабых материалов: ${skippedCount}. Порог полезности — ${MIN_RELEVANCE_SCORE}/100.`
    : `Все обработанные материалы прошли порог полезности ${MIN_RELEVANCE_SCORE}/100.`;

  return [
    marker,
    '',
    `Отобраны только сигналы с практической полезностью для TexturaLab. ${filterNote}`,
    '',
    '### Что требует внимания в первую очередь',
    '',
    ...sorted.slice(0, 3).map(({ card }, index) => (
      `${index + 1}. **${card.title_ru}** — ${card.signal}`
    )),
    '',
    ...groupedSections.flatMap((section, index) => (
      index === groupedSections.length - 1 ? [section] : [section, '', '---', '']
    )),
    '',
    '### Что делать TexturaLab',
    '',
    actionLines,
    '',
    '### Как читать этот дайджест',
    '',
    'Оценка отражает не важность новости вообще, а её возможную практическую ценность именно для TexturaLab. Один материал не считается доказательством рыночного тренда; повторяющиеся сигналы нужно подтверждать другими источниками.',
    '',
    ...ending,
  ].filter((part) => part !== null && part !== undefined).join('\n');
}

export async function generateDigest(db, articles, config) {
  const log = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  log.push(`Starting ranked digest generation for ${articles.length} articles`);

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

  const analyzedEntries = [];

  for (const article of articles) {
    try {
      if (article.commentary) {
        try {
          const card = parseCardFromCommentary(article.commentary);
          analyzedEntries.push({ article, card });
          log.push(`Reused ranked commentary for article ${article.id}`);
          continue;
        } catch {
          // Старый комментарий без рейтинга/категории или повреждённый JSON — анализируем заново.
        }
      }

      updateArticleStatus(article.id, 'processing');

      const result = await analyzeArticle(article, commentarySystem, config, log);
      totalInputTokens += result.totalInputTokens;
      totalOutputTokens += result.totalOutputTokens;

      const storedJson = JSON.stringify(result.card, null, 2);
      updateArticleCommentary(article.id, storedJson);
      article.commentary = storedJson;

      analyzedEntries.push({ article, card: result.card });
      log.push(
        `Generated ranked analysis for article ${article.id}: `
        + `score=${result.card.relevance_score}, category=${result.card.category}`
      );

      await sleep(INTER_CALL_DELAY_MS);
    } catch (error) {
      log.push(`Error analyzing article ${article.id}: ${error.message}`);
      updateArticleStatus(article.id, 'error');
    }
  }

  if (analyzedEntries.length === 0) {
    throw new Error('No valid structured article analyses — cannot assemble digest');
  }

  const entries = analyzedEntries
    .filter(({ card }) => card.relevance_score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.card.relevance_score - a.card.relevance_score);

  const skippedEntries = analyzedEntries.filter(
    ({ card }) => card.relevance_score < MIN_RELEVANCE_SCORE
  );

  for (const { article, card } of skippedEntries) {
    log.push(`Filtered weak article ${article.id}: score=${card.relevance_score}`);
    updateArticleStatus(article.id, 'ignored');
  }

  if (entries.length === 0) {
    throw new Error(`All analyzed articles scored below ${MIN_RELEVANCE_SCORE}`);
  }

  // Финальный текст собирается обычным кодом. Второй вызов модели не используется.
  const digestContent = buildDigest(entries, config, skippedEntries.length);
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
    + `Model: ${config.claudeModel} | ranked assembly=true | `
    + `included=${entries.length} filtered=${skippedEntries.length}`
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
