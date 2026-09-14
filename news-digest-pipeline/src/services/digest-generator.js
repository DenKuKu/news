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
const SYNTHESIS_ATTEMPTS = 2;
const MIN_RELEVANCE_SCORE = 55;
const MAX_ACTIONS = 5;
const MAX_CLUSTERS = 5;

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
  if (!Number.isFinite(numeric)) throw new Error('relevance_score должен быть числом от 0 до 100');
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
  const evidenceChain = cleanText(value.evidence_chain, 650);
  const relation = cleanText(value.relation, 30).toLowerCase();
  const category = cleanText(value.category, 40).toLowerCase();
  let relevanceScore = normalizeScore(value.relevance_score);
  let confidence = cleanText(value.confidence, 30).toLowerCase();
  const actionSupported = value.action_supported === true;

  const factsSource = Array.isArray(value.facts) ? value.facts : typeof value.facts === 'string' ? [value.facts] : [];
  const facts = factsSource.map((fact) => cleanText(fact, 350)).filter(Boolean).slice(0, 4);

  if (titleRu.length < 3) throw new Error('Пустой title_ru');
  if (facts.length === 0) throw new Error('Пустой массив facts');
  if (signal.length < 8) throw new Error('Пустой signal');
  if (action.length < 8) throw new Error('Пустой action');
  if (question.length < 8) throw new Error('Пустой question');
  if (evidenceChain.length < 8) throw new Error('Пустой evidence_chain');
  if (!RELATIONS.has(relation)) throw new Error('relation должна быть: прямая, смежная или слабая');
  if (!CATEGORIES.has(category)) throw new Error(`Неизвестная category: ${category}`);

  if (confidence === 'высокая') confidence = 'средняя';
  if (!CONFIDENCE_LEVELS.has(confidence)) throw new Error('confidence должна быть: низкая или средняя');

  // Жёсткий evidence gate: если модель сама не может обосновать действие фактами RSS,
  // материал не должен пройти порог только за счёт красивой гипотезы.
  if (!actionSupported) relevanceScore = Math.min(relevanceScore, 49);
  if (relation === 'слабая') relevanceScore = Math.min(relevanceScore, 49);

  return {
    title_ru: titleRu,
    facts,
    signal,
    relation,
    confidence,
    relevance_score: relevanceScore,
    category,
    action,
    action_supported: actionSupported,
    evidence_chain: evidenceChain,
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
    '- B2B для мебельных фабрик, декораторов и интерьерных студий.',
    '- Приоритет: цифровая сублимационная печать по полиэстеровым мебельным тканям, короткие серии, дизайн по запросу.',
    '- Производственный интерес: окрашивание, отделка, пропитка полиэстера, сушка, термофиксация, нанесение химии, контроль процесса.',
    '- Нужны сигналы, способные повлиять на продукт, технологию, продажи, позиционирование или выбор ниши.',
    '',
    `ЗАГОЛОВОК ИСТОЧНИКА: ${article.title || 'не указан'}`,
    '',
    'КРАТКОЕ СОДЕРЖАНИЕ RSS:',
    contentTruncated || 'не предоставлено',
    '',
    'КРИТИЧЕСКОЕ ПРАВИЛО ДОКАЗАТЕЛЬНОСТИ:',
    'Практическое действие разрешено только при ясной цепочке ФАКТ ИЗ RSS -> ЗНАЧЕНИЕ ДЛЯ КОНКРЕТНОГО НАПРАВЛЕНИЯ TEXTURALAB -> ДЕЙСТВИЕ.',
    'Если хотя бы одно звено требует выдумать новое применение, клиента, материал, технологию или рынок, поставь action_supported=false и relevance_score не выше 49.',
    'Не превращай деятельность героя статьи в нишу TexturaLab. Пример: дизайнер продаёт открытки — это НЕ означает рынок тканей для открыток.',
    'Не превращай арт-инсталляцию в рынок архитектурного текстиля, если RSS прямо не говорит о ткани или текстильной технологии.',
    'Не называй оборудование отделки оборудованием цифровой печати.',
    '',
    'Шкала relevance_score:',
    '- 85-100: прямой сильный сигнал, способный изменить решение/технологию/продукт/продажи.',
    '- 70-84: полезный и хорошо обоснованный сигнал.',
    '- 55-69: умеренно полезный, но с конкретной доказуемой связью.',
    '- 30-54: слабая или спекулятивная связь.',
    '- 0-29: шум.',
    '',
    'Категории: production | print-business | design-trends | furniture-market | new-niches | other.',
    '',
    'Верни только JSON:',
    '{',
    '  "title_ru": "естественный русский заголовок",',
    '  "facts": ["факт 1", "факт 2"],',
    '  "signal": "что это означает для TexturaLab без выдумывания",',
    '  "relation": "прямая | смежная | слабая",',
    '  "confidence": "низкая | средняя",',
    '  "relevance_score": 0,',
    '  "category": "production | print-business | design-trends | furniture-market | new-niches | other",',
    '  "evidence_chain": "факт -> значение для направления TexturaLab -> почему действие оправдано",',
    '  "action_supported": true,',
    '  "action": "одно конкретное действие; если action_supported=false, напиши: Нет обоснованного действия",',
    '  "question": "конкретный вопрос для проверки"',
    '}',
    '',
    'Используй только сведения RSS. Не придумывай отсутствующие факты и причинные связи.',
  ].join('\n');

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= ANALYSIS_ATTEMPTS; attempt += 1) {
    const userMessage = attempt === 1 ? baseUserMessage : `${baseUserMessage}\n\nПредыдущий ответ не прошёл проверку: ${lastError?.message}. Исправь JSON.`;
    const response = await callModel(config, { system: commentarySystem, user: userMessage, maxTokens: 1200 });
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    try {
      return { card: normalizeCard(extractJson(response.text)), totalInputTokens, totalOutputTokens };
    } catch (error) {
      lastError = error;
      log.push(`Article ${article.id}: invalid JSON attempt ${attempt}: ${error.message}`);
    }
  }
  throw lastError || new Error('Не удалось получить валидный JSON');
}

function normalizeSynthesis(value, allowedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Synthesis должен быть JSON-объектом');
  const clustersSource = Array.isArray(value.clusters) ? value.clusters : [];
  const clusters = clustersSource.map((cluster) => {
    const sourceIds = (Array.isArray(cluster.source_ids) ? cluster.source_ids : [])
      .map((id) => String(id))
      .filter((id) => allowedIds.has(id));
    return {
      title: cleanText(cluster.title, 180),
      finding: cleanText(cluster.finding, 700),
      why_it_matters: cleanText(cluster.why_it_matters, 700),
      action: cleanText(cluster.action, 500),
      confidence: cleanText(cluster.confidence, 30).toLowerCase(),
      source_ids: [...new Set(sourceIds)],
    };
  }).filter((cluster) => cluster.title && cluster.finding && cluster.why_it_matters && cluster.action && cluster.source_ids.length > 0)
    .slice(0, MAX_CLUSTERS);

  if (clusters.length === 0) throw new Error('Synthesis не содержит валидных кластеров');
  return { clusters };
}

async function synthesizeEntries(entries, config, log) {
  const allowedIds = new Set(entries.map(({ article }) => String(article.id)));
  const compact = entries.map(({ article, card }) => ({
    id: String(article.id),
    source: (article.source || '').replace(/^rss:/, ''),
    title: article.title,
    category: card.category,
    score: card.relevance_score,
    facts: card.facts,
    signal: card.signal,
    evidence_chain: card.evidence_chain,
    action: card.action,
  }));

  const system = [
    '/no_think',
    'Ты — старший аналитик TexturaLab. Твоя задача — синтезировать уже проверенные отраслевые сигналы.',
    'Не добавляй фактов вне переданного JSON.',
  ].join('\n');
  const baseUserMessage = [
    'Собери из материалов 2-5 аналитических кластеров. Не пересказывай статьи по одной.',
    'Объединяй статьи только когда между ними есть содержательная общая тема.',
    'Если один материал сам по себе важен, он может образовать кластер из одной статьи.',
    'Приоритетные оси TexturaLab: on-demand/короткие серии цифровой печати; принты и повторяющиеся визуальные сигналы; отделка/пропитка/термофиксация/текстильная химия; мебельный рынок.',
    'Действие должно следовать из фактов кластера. Не придумывай новые рынки и применения.',
    'Для production ищи применимость к полиэстеру, сушке, термофиксации, нанесению химии и контролю процесса — но только как вопрос для проверки, если деталей нет в источнике.',
    'Для design-trends формулируй тест капсулы/гипотезы, а не утверждай существование широкого тренда без нескольких подтверждений.',
    '',
    'Верни только JSON:',
    '{"clusters":[{"title":"...","finding":"что совместно показывают материалы","why_it_matters":"почему это важно TexturaLab","action":"одно действие","confidence":"низкая | средняя","source_ids":["id1","id2"]}]}',
    '',
    'МАТЕРИАЛЫ:',
    JSON.stringify(compact),
  ].join('\n');

  let inputTokens = 0;
  let outputTokens = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= SYNTHESIS_ATTEMPTS; attempt += 1) {
    const user = attempt === 1 ? baseUserMessage : `${baseUserMessage}\nПредыдущий JSON не прошёл проверку: ${lastError?.message}.`;
    const response = await callModel(config, { system, user, maxTokens: 1800 });
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    try {
      const synthesis = normalizeSynthesis(extractJson(response.text), allowedIds);
      return { synthesis, inputTokens, outputTokens };
    } catch (error) {
      lastError = error;
      log.push(`Synthesis invalid JSON attempt ${attempt}: ${error.message}`);
    }
  }
  throw lastError || new Error('Не удалось синтезировать сигналы');
}

function renderEntry({ article, card }) {
  const factLines = card.facts.map((fact) => `- ${fact}`).join('\n');
  return [
    `#### ${card.title_ru}`,
    '',
    `**Полезность для TexturaLab:** ${card.relevance_score}/100 · ${card.relation} связь · уверенность ${card.confidence}`,
    '',
    '**Что известно**', factLines, '',
    '**Почему это важно**', card.signal, '',
    '**Доказательная цепочка**', card.evidence_chain, '',
    '**Что делать / проверить**', card.action, '',
    `Контрольный вопрос: ${card.question}`, '',
    `Источник: ${(article.source || '').replace(/^rss:/, '').replace(/^www\./, '')}`,
    `Читать оригинал: ${article.url}`,
  ].join('\n');
}

function buildDigest(entries, synthesis, config, skippedCount = 0) {
  const marker = '#ДайджестTexturaLab';
  const sorted = [...entries].sort((a, b) => b.card.relevance_score - a.card.relevance_score);
  const byId = new Map(sorted.map((entry) => [String(entry.article.id), entry]));

  const clusterSections = synthesis.clusters.map((cluster, index) => {
    const sources = cluster.source_ids.map((id) => byId.get(id)).filter(Boolean);
    const sourceLines = sources.map(({ article }) => `- ${(article.source || '').replace(/^rss:/, '').replace(/^www\./, '')}: ${article.title}\n  ${article.url}`).join('\n');
    return [
      `### ${index + 1}. ${cluster.title}`,
      '',
      `**Вывод:** ${cluster.finding}`,
      '',
      `**Почему это важно TexturaLab:** ${cluster.why_it_matters}`,
      '',
      `**Действие:** ${cluster.action}`,
      '',
      `**Уверенность:** ${cluster.confidence || 'средняя'}`,
      '',
      '**Основание**',
      sourceLines,
    ].join('\n');
  });

  const groupedSections = [];
  for (const category of CATEGORY_ORDER) {
    const categoryEntries = sorted.filter(({ card }) => card.category === category);
    if (categoryEntries.length === 0) continue;
    groupedSections.push([
      `### ${CATEGORY_LABELS[category]}`,
      '',
      ...categoryEntries.flatMap((entry, index) => index === categoryEntries.length - 1 ? [renderEntry(entry)] : [renderEntry(entry), '', '---', '']),
    ].join('\n'));
  }

  const actions = [];
  const seen = new Set();
  for (const cluster of synthesis.clusters) {
    const action = cleanText(cluster.action, 500);
    const key = action.toLowerCase();
    if (!action || seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
    if (actions.length >= MAX_ACTIONS) break;
  }
  const actionLines = actions.length ? actions.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'Нет действий, достаточно обоснованных текущими материалами.';

  const ending = [];
  if (cleanText(config.boundaryIntent, 1000)) ending.push(cleanText(config.boundaryIntent, 1000));
  if (cleanText(config.hashtagsSuffix, 1000)) ending.push(cleanText(config.hashtagsSuffix, 1000));
  const filterNote = skippedCount > 0 ? `Отсеяно слабых/спекулятивных материалов: ${skippedCount}. Порог — ${MIN_RELEVANCE_SCORE}/100.` : `Все материалы прошли порог ${MIN_RELEVANCE_SCORE}/100.`;

  return [
    marker, '',
    `Сначала — синтез повторяющихся и наиболее практичных сигналов. ${filterNote}`, '',
    '## Главные выводы', '',
    ...clusterSections.flatMap((section, index) => index === clusterSections.length - 1 ? [section] : [section, '', '---', '']),
    '', '## Что делать TexturaLab', '', actionLines,
    '', '## Материалы, прошедшие фильтр', '',
    ...groupedSections.flatMap((section, index) => index === groupedSections.length - 1 ? [section] : [section, '', '---', '']),
    '', '### Как читать этот дайджест', '',
    'Верхний блок — аналитический синтез нескольких сигналов, а не рейтинг отдельных новостей. Действия допускаются только при явной цепочке от фактов источника к задаче TexturaLab. Один материал сам по себе не считается доказательством широкого рыночного тренда.',
    '', ...ending,
  ].filter((part) => part !== null && part !== undefined).join('\n');
}

export async function generateDigest(db, articles, config) {
  const log = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  log.push(`Starting evidence-gated digest generation for ${articles.length} articles`);

  const recovered = db.prepare(`UPDATE articles SET status = 'new', updated_at = datetime('now') WHERE status = 'processing' AND digest_id IS NULL AND updated_at < datetime('now', '-30 minutes')`).run().changes;
  if (recovered > 0) log.push(`Recovered stale processing articles: ${recovered}`);

  const scenario = config.activeScenario || 'architect';
  let commentarySystem = scenario === 'architect' ? config.deepPrompt : config.commentaryPrompt;
  if (!commentarySystem || !commentarySystem.trim()) commentarySystem = ['/no_think', 'Ты — аналитик отраслевых сигналов TexturaLab.', 'Используй только сведения из RSS.', 'Не придумывай факты.'].join('\n');

  const analyzedEntries = [];
  for (const article of articles) {
    try {
      if (article.commentary) {
        try {
          const card = parseCardFromCommentary(article.commentary);
          analyzedEntries.push({ article, card });
          log.push(`Reused evidence-gated commentary for article ${article.id}`);
          continue;
        } catch { /* старый формат — анализируем заново */ }
      }
      updateArticleStatus(article.id, 'processing');
      const result = await analyzeArticle(article, commentarySystem, config, log);
      totalInputTokens += result.totalInputTokens;
      totalOutputTokens += result.totalOutputTokens;
      const storedJson = JSON.stringify(result.card, null, 2);
      updateArticleCommentary(article.id, storedJson);
      article.commentary = storedJson;
      analyzedEntries.push({ article, card: result.card });
      log.push(`Generated evidence-gated analysis for article ${article.id}: score=${result.card.relevance_score}, category=${result.card.category}, supported=${result.card.action_supported}`);
      await sleep(INTER_CALL_DELAY_MS);
    } catch (error) {
      log.push(`Error analyzing article ${article.id}: ${error.message}`);
      updateArticleStatus(article.id, 'error');
    }
  }

  if (analyzedEntries.length === 0) throw new Error('No valid structured article analyses — cannot assemble digest');
  const entries = analyzedEntries.filter(({ card }) => card.relevance_score >= MIN_RELEVANCE_SCORE).sort((a, b) => b.card.relevance_score - a.card.relevance_score);
  const skippedEntries = analyzedEntries.filter(({ card }) => card.relevance_score < MIN_RELEVANCE_SCORE);
  for (const { article, card } of skippedEntries) {
    log.push(`Filtered weak/speculative article ${article.id}: score=${card.relevance_score}`);
    updateArticleStatus(article.id, 'ignored');
  }
  if (entries.length === 0) throw new Error(`All analyzed articles scored below ${MIN_RELEVANCE_SCORE}`);

  const synthesisResult = await synthesizeEntries(entries, config, log);
  totalInputTokens += synthesisResult.inputTokens;
  totalOutputTokens += synthesisResult.outputTokens;
  log.push(`Synthesized ${synthesisResult.synthesis.clusters.length} cross-article clusters`);

  const digestContent = buildDigest(entries, synthesisResult.synthesis, config, skippedEntries.length);
  const today = new Date().toISOString().slice(0, 10);
  const digestId = createDigest({ date: today, part: 1, articlesCount: entries.length });

  const pricing = priceFor(config.claudeModel);
  let costUsd = null;
  if (pricing) {
    const rawCost = (totalInputTokens / 1e6) * pricing.input + (totalOutputTokens / 1e6) * pricing.output;
    costUsd = Math.round(rawCost * 1e6) / 1e6;
  }

  log.push(`Tokens: in=${totalInputTokens} out=${totalOutputTokens} | Model: ${config.claudeModel} | synthesis=true | included=${entries.length} filtered=${skippedEntries.length}`);
  updateDigest(digestId, { content: digestContent, status: 'draft', generation_log: log.join('\n'), model: config.claudeModel, input_tokens: totalInputTokens, output_tokens: totalOutputTokens, cost_usd: costUsd });

  const articleIds = entries.map(({ article }) => article.id);
  assignArticlesToDigest(articleIds, digestId);
  const filePath = saveDigestToFile(today, digestContent);
  log.push(`Digest saved to file: ${filePath}`);
  log.push(`Digest created: ${digestId}`);

  const saved = getDigest(digestId);
  const digestOk = saved && typeof saved.content === 'string' && saved.content.length > 100 && saved.content.includes('#ДайджестTexturaLab');
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
        const ok = await deleteTelegramMessage(config.telegramBotToken, article.source_chat_id, Number(article.source_message_id));
        if (ok) deleted += 1; else failed += 1;
      } catch { failed += 1; }
    }
    log.push(`Telegram source cleanup: deleted=${deleted}, failed=${failed}`);
  }

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
