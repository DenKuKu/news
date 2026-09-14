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
const SYNTHESIS_FLOOR = 40;
const MAX_ACTIONS = 5;
const MAX_CLUSTERS = 5;

const CONFIDENCE_LEVELS = new Set(['низкая', 'средняя']);
const CATEGORIES = new Set([
  'production',
  'print-business',
  'design-trends',
  'furniture-market',
  'new-niches',
  'other',
]);
const SIGNAL_TYPES = new Set([
  'digital-printing',
  'on-demand',
  'equipment-finishing',
  'textile-chemistry',
  'design-trend',
  'designer-case',
  'furniture-market',
  'installation-art',
  'automation',
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
  if (start === -1 || end === -1 || end <= start) throw new Error('Модель не вернула JSON-объект');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error('relevance_score должен быть числом от 0 до 100');
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ответ модели должен быть JSON-объектом');

  const titleRu = cleanText(value.title_ru, 180);
  const summary = cleanText(value.summary, 500);
  const category = cleanText(value.category, 40).toLowerCase();
  const signalType = cleanText(value.signal_type, 40).toLowerCase();
  let confidence = cleanText(value.confidence, 30).toLowerCase();
  const modelScore = normalizeScore(value.relevance_score);
  const factsSource = Array.isArray(value.facts) ? value.facts : typeof value.facts === 'string' ? [value.facts] : [];
  const facts = factsSource.map((fact) => cleanText(fact, 350)).filter(Boolean).slice(0, 5);

  if (titleRu.length < 3) throw new Error('Пустой title_ru');
  if (facts.length === 0) throw new Error('Пустой массив facts');
  if (summary.length < 8) throw new Error('Пустой summary');
  if (!CATEGORIES.has(category)) throw new Error(`Неизвестная category: ${category}`);
  if (!SIGNAL_TYPES.has(signalType)) throw new Error(`Неизвестный signal_type: ${signalType}`);
  if (confidence === 'высокая') confidence = 'средняя';
  if (!CONFIDENCE_LEVELS.has(confidence)) throw new Error('confidence должна быть: низкая или средняя');

  return {
    title_ru: titleRu,
    facts,
    summary,
    category,
    signal_type: signalType,
    confidence,
    model_score: modelScore,
    relevance_score: modelScore,
    score_reason: 'model',
  };
}

function textOf(article) {
  return `${article.title || ''}\n${article.content || ''}`.toLowerCase();
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function applyProgrammaticScore(article, card) {
  const text = textOf(article);
  let score = card.model_score;
  let signalType = card.signal_type;
  let category = card.category;
  const reasons = [];

  const textileTerms = ['textile', 'fabric', 'fabrics', 'polyester', 'yarn', 'dyeing', 'finishing', 'coating', 'printing', 'print'];
  const digitalTerms = ['digital textile', 'digital printing', 'digital print', 'kornit', 'atlas max', 'inkjet'];
  const onDemandTerms = ['on-demand', 'on demand', 'short run', 'short-run', 'agile manufacturing', 'mass customization'];
  const chemistryTerms = ['textile chemicals', 'chemicals', 'chemical', 'finishing agent', 'coating', 'resil chemicals'];
  const finishingTerms = ['finishing', 'thermofix', 'heat setting', 'heat-setting', 'stenter', 'brückner', 'bruckner', 'dyeing', 'coating'];
  const automationTerms = ['automation', 'automated', 'ai', 'artificial intelligence', 'digital solution', 'intelligent textile'];
  const artTerms = ['installation', 'sculpture', 'art installation', 'grand palais', 'design week'];
  const designerCaseTerms = ['designer feature', 'designer profile', 'illustrator', 'surface designer'];
  const trendTerms = ['textile design trends', 'trend', 'trends', 'what’s selling', "what's selling"];

  const explicitTextile = hasAny(text, textileTerms);
  const explicitDigital = hasAny(text, digitalTerms);
  const explicitOnDemand = hasAny(text, onDemandTerms);
  const explicitChemistry = hasAny(text, chemistryTerms) && explicitTextile;
  const explicitFinishing = hasAny(text, finishingTerms) && explicitTextile;
  const explicitAutomation = hasAny(text, automationTerms) && explicitTextile;
  const explicitArt = hasAny(text, artTerms);
  const explicitDesignerCase = hasAny(text, designerCaseTerms);
  const explicitTrend = hasAny(text, trendTerms) && explicitTextile;

  if (explicitOnDemand && explicitDigital) {
    signalType = 'on-demand';
    category = 'print-business';
    score = Math.max(score, 70);
    reasons.push('direct on-demand digital textile signal');
  } else if (explicitDigital && explicitTextile) {
    signalType = 'digital-printing';
    category = 'print-business';
    score = Math.max(score, 62);
    reasons.push('direct digital textile printing signal');
  }

  if (explicitFinishing) {
    if (!['on-demand', 'digital-printing'].includes(signalType)) signalType = 'equipment-finishing';
    if (!['print-business'].includes(category)) category = 'production';
    score = Math.max(score, 55);
    reasons.push('explicit textile finishing/equipment signal');
  }

  if (explicitChemistry) {
    signalType = 'textile-chemistry';
    category = 'production';
    score = Math.max(score, 55);
    reasons.push('explicit textile chemistry signal');
  }

  if (explicitAutomation && !explicitDigital) {
    signalType = 'automation';
    category = 'production';
    score = Math.max(score, 52);
    reasons.push('textile automation signal');
  }

  if (explicitTrend && !explicitDesignerCase) {
    signalType = 'design-trend';
    category = 'design-trends';
    score = Math.max(score, 55);
    reasons.push('explicit textile trend article');
  }

  if (explicitDesignerCase || signalType === 'designer-case') {
    signalType = 'designer-case';
    category = 'design-trends';
    score = Math.min(score, 49);
    reasons.push('single designer case capped');
  }

  if (explicitArt && !explicitTextile) {
    signalType = 'installation-art';
    category = 'other';
    score = Math.min(score, 29);
    reasons.push('art/installation without explicit textile link capped');
  }

  if (signalType === 'installation-art' && !explicitTextile) {
    score = Math.min(score, 29);
    reasons.push('installation-art cap');
  }

  if (signalType === 'other' && !explicitTextile) {
    score = Math.min(score, 39);
    reasons.push('generic non-textile signal capped');
  }

  return {
    ...card,
    signal_type: signalType,
    category,
    relevance_score: Math.max(0, Math.min(100, Math.round(score))),
    score_reason: reasons.length ? reasons.join('; ') : 'model score retained',
  };
}

function parseCardFromCommentary(commentary, article) {
  const parsed = extractJson(commentary);
  if (!parsed.signal_type || !parsed.summary || parsed.action_supported !== undefined || parsed.evidence_chain !== undefined) {
    throw new Error('Старый формат commentary');
  }
  return applyProgrammaticScore(article, normalizeCard(parsed));
}

async function analyzeArticle(article, commentarySystem, config, log) {
  const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);
  const baseUserMessage = [
    'КОНТЕКСТ TEXTURALAB нужен только для оценки релевантности, но НЕ для придумывания применений.',
    '- B2B: мебельные фабрики, декораторы, интерьерные студии.',
    '- Приоритет: цифровая сублимационная печать по полиэстеровым мебельным тканям, короткие серии, дизайн по запросу.',
    '- Дополнительный интерес: окрашивание, отделка, пропитка, сушка, термофиксация, текстильная химия, автоматизация.',
    '',
    `ЗАГОЛОВОК: ${article.title || 'не указан'}`,
    '',
    'RSS:',
    contentTruncated || 'не предоставлено',
    '',
    'ТВОЯ РОЛЬ НА ЭТОМ ШАГЕ — ТОЛЬКО ИЗВЛЕЧЕНИЕ И КЛАССИФИКАЦИЯ ФАКТОВ.',
    'Не предлагай действия TexturaLab. Не строй причинные цепочки. Не расширяй единичный кейс до рыночного тренда.',
    'Если статья про одного дизайнера — signal_type=designer-case.',
    'Если статья про арт-объект/инсталляцию без явной ткани/печати — signal_type=installation-art.',
    'Если прямо говорится про on-demand/short-run цифровое текстильное производство — signal_type=on-demand.',
    'Если про цифровую печать — signal_type=digital-printing.',
    'Если про отделочное оборудование/крашение/термообработку — signal_type=equipment-finishing.',
    'Если про химию для текстиля — signal_type=textile-chemistry.',
    'Если про AI/автоматизацию текстильного процесса — signal_type=automation.',
    'Если источник сам называет материал трендом/what is selling — signal_type=design-trend.',
    '',
    'Верни только JSON:',
    '{',
    '  "title_ru": "русский заголовок",',
    '  "facts": ["только факты из RSS", "ещё факт"],',
    '  "summary": "нейтрально: о чём материал без вывода для TexturaLab",',
    '  "signal_type": "digital-printing | on-demand | equipment-finishing | textile-chemistry | design-trend | designer-case | furniture-market | installation-art | automation | other",',
    '  "category": "production | print-business | design-trends | furniture-market | new-niches | other",',
    '  "confidence": "низкая | средняя",',
    '  "relevance_score": 0',
    '}',
    '',
    'relevance_score — предварительная оценка. Программные правила после тебя могут её изменить.',
    'Не добавляй сведения, которых нет в RSS.',
  ].join('\n');

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= ANALYSIS_ATTEMPTS; attempt += 1) {
    const userMessage = attempt === 1 ? baseUserMessage : `${baseUserMessage}\n\nПредыдущий ответ не прошёл проверку: ${lastError?.message}. Исправь JSON.`;
    const response = await callModel(config, { system: commentarySystem, user: userMessage, maxTokens: 900 });
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    try {
      const card = applyProgrammaticScore(article, normalizeCard(extractJson(response.text)));
      return { card, totalInputTokens, totalOutputTokens };
    } catch (error) {
      lastError = error;
      log.push(`Article ${article.id}: invalid extraction attempt ${attempt}: ${error.message}`);
    }
  }
  throw lastError || new Error('Не удалось получить валидный JSON');
}

function normalizeSynthesis(value, candidateMap) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Synthesis должен быть JSON-объектом');
  const clustersSource = Array.isArray(value.clusters) ? value.clusters : [];
  const clusters = clustersSource.map((cluster) => {
    const sourceIds = [...new Set((Array.isArray(cluster.source_ids) ? cluster.source_ids : []).map(String).filter((id) => candidateMap.has(id)))];
    return {
      title: cleanText(cluster.title, 180),
      finding: cleanText(cluster.finding, 700),
      why_it_matters: cleanText(cluster.why_it_matters, 700),
      action: cleanText(cluster.action, 500),
      confidence: cleanText(cluster.confidence, 30).toLowerCase(),
      source_ids: sourceIds,
    };
  }).filter((cluster) => {
    if (!cluster.title || !cluster.finding || !cluster.why_it_matters || !cluster.action || cluster.source_ids.length === 0) return false;
    const sourceEntries = cluster.source_ids.map((id) => candidateMap.get(id));
    if (sourceEntries.length === 1) {
      const only = sourceEntries[0];
      const directTypes = new Set(['on-demand', 'digital-printing', 'equipment-finishing', 'textile-chemistry', 'furniture-market', 'automation']);
      return only.card.relevance_score >= 70 && directTypes.has(only.card.signal_type);
    }
    return sourceEntries.some((entry) => entry.card.relevance_score >= MIN_RELEVANCE_SCORE);
  }).slice(0, MAX_CLUSTERS);

  if (clusters.length === 0) throw new Error('Synthesis не содержит валидных кластеров');
  return { clusters };
}

async function synthesizeEntries(candidates, config, log) {
  const candidateMap = new Map(candidates.map((entry) => [String(entry.article.id), entry]));
  const compact = candidates.map(({ article, card }) => ({
    id: String(article.id),
    source: (article.source || '').replace(/^rss:/, ''),
    title: article.title,
    score: card.relevance_score,
    signal_type: card.signal_type,
    category: card.category,
    facts: card.facts,
    summary: card.summary,
  }));

  const system = [
    '/no_think',
    'Ты — старший аналитик TexturaLab.',
    'Работай только с переданными фактами. Не добавляй факты и не создавай рынки из единичных кейсов.',
  ].join('\n');
  const baseUserMessage = [
    'Собери 2-5 аналитических кластеров из материалов с score >= 40.',
    'Это второй этап: здесь разрешено делать выводы, но только из нескольких совместимых сигналов или из одного очень прямого сильного сигнала.',
    'Сначала ищи пары/группы одного направления:',
    '- on-demand + digital-printing;',
    '- equipment-finishing + textile-chemistry;',
    '- несколько design-trend материалов;',
    '- automation только с другими производственными материалами.',
    'Не объединяй статьи только потому, что обе относятся к textile.',
    'Designer-case и installation-art не должны становиться самостоятельными рыночными выводами.',
    'Пограничная статья score 40-54 может попасть в итог только как подтверждение более сильного сигнала в кластере из 2+ материалов.',
    'Формулируй действие как небольшой проверяемый шаг: тест капсулы, проверка применимости технологии, запрос спецификаций, проверка экономики.',
    'Не утверждай рост рынка/спроса без прямого подтверждения несколькими материалами.',
    '',
    'Верни только JSON:',
    '{"clusters":[{"title":"...","finding":"что совместно подтверждают источники","why_it_matters":"конкретное значение для TexturaLab","action":"одно проверяемое действие","confidence":"низкая | средняя","source_ids":["id1","id2"]}]}',
    '',
    'МАТЕРИАЛЫ:',
    JSON.stringify(compact),
  ].join('\n');

  let inputTokens = 0;
  let outputTokens = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= SYNTHESIS_ATTEMPTS; attempt += 1) {
    const user = attempt === 1 ? baseUserMessage : `${baseUserMessage}\nПредыдущий JSON не прошёл проверку: ${lastError?.message}.`;
    const response = await callModel(config, { system, user, maxTokens: 1600 });
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    try {
      return { synthesis: normalizeSynthesis(extractJson(response.text), candidateMap), inputTokens, outputTokens };
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
    `**Полезность:** ${card.relevance_score}/100 · тип ${card.signal_type} · уверенность ${card.confidence}`,
    '',
    '**Факты из RSS**', factLines, '',
    '**Нейтральное резюме**', card.summary, '',
    `**Почему такой балл:** ${card.score_reason}`,
    '',
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
      '', `**Вывод:** ${cluster.finding}`,
      '', `**Почему это важно TexturaLab:** ${cluster.why_it_matters}`,
      '', `**Действие:** ${cluster.action}`,
      '', `**Уверенность:** ${cluster.confidence || 'средняя'}`,
      '', '**Основание**', sourceLines,
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
  const actionLines = actions.length ? actions.map((action, index) => `${index + 1}. ${action}`).join('\n') : 'Нет действий, достаточно обоснованных текущими материалами.';
  const ending = [];
  if (cleanText(config.boundaryIntent, 1000)) ending.push(cleanText(config.boundaryIntent, 1000));
  if (cleanText(config.hashtagsSuffix, 1000)) ending.push(cleanText(config.hashtagsSuffix, 1000));
  const filterNote = skippedCount > 0 ? `Отсеяно материалов: ${skippedCount}. Порог основного дайджеста — ${MIN_RELEVANCE_SCORE}/100; пограничные ${SYNTHESIS_FLOOR}-${MIN_RELEVANCE_SCORE - 1} могли быть повышены только кластером.` : `Все обработанные материалы вошли в итог.`;

  return [
    marker, '',
    `Сначала — синтез повторяющихся и наиболее практичных сигналов. ${filterNote}`, '',
    '## Главные выводы', '',
    ...clusterSections.flatMap((section, index) => index === clusterSections.length - 1 ? [section] : [section, '', '---', '']),
    '', '## Что делать TexturaLab', '', actionLines,
    '', '## Материалы, вошедшие в итог', '',
    ...groupedSections.flatMap((section, index) => index === groupedSections.length - 1 ? [section] : [section, '', '---', '']),
    '', '### Как читать этот дайджест', '',
    'Первый проход извлекает факты без действий. Балл затем корректируется программными правилами. Второй проход видит также пограничные материалы и может использовать их только как подтверждение более сильного сигнала.',
    '', ...ending,
  ].filter((part) => part !== null && part !== undefined).join('\n');
}

export async function generateDigest(db, articles, config) {
  const log = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  log.push(`Starting fact-first digest generation for ${articles.length} articles`);

  const recovered = db.prepare(`UPDATE articles SET status = 'new', updated_at = datetime('now') WHERE status = 'processing' AND digest_id IS NULL AND updated_at < datetime('now', '-30 minutes')`).run().changes;
  if (recovered > 0) log.push(`Recovered stale processing articles: ${recovered}`);

  const scenario = config.activeScenario || 'architect';
  let commentarySystem = scenario === 'architect' ? config.deepPrompt : config.commentaryPrompt;
  if (!commentarySystem || !commentarySystem.trim()) commentarySystem = ['/no_think', 'Ты извлекаешь факты из отраслевых RSS.', 'Не придумывай факты и применения.'].join('\n');

  const analyzedEntries = [];
  for (const article of articles) {
    try {
      if (article.commentary) {
        try {
          const card = parseCardFromCommentary(article.commentary, article);
          analyzedEntries.push({ article, card });
          log.push(`Reused fact-first commentary for article ${article.id}: score=${card.relevance_score}`);
          continue;
        } catch { /* старый формат */ }
      }

      updateArticleStatus(article.id, 'processing');
      const result = await analyzeArticle(article, commentarySystem, config, log);
      totalInputTokens += result.totalInputTokens;
      totalOutputTokens += result.totalOutputTokens;
      const storedJson = JSON.stringify(result.card, null, 2);
      updateArticleCommentary(article.id, storedJson);
      article.commentary = storedJson;
      analyzedEntries.push({ article, card: result.card });
      log.push(`Extracted article ${article.id}: model=${result.card.model_score}, final=${result.card.relevance_score}, type=${result.card.signal_type}, reason=${result.card.score_reason}`);
      await sleep(INTER_CALL_DELAY_MS);
    } catch (error) {
      log.push(`Error analyzing article ${article.id}: ${error.message}`);
      updateArticleStatus(article.id, 'error');
    }
  }

  if (analyzedEntries.length === 0) throw new Error('No valid article analyses — cannot assemble digest');

  const candidates = analyzedEntries.filter(({ card }) => card.relevance_score >= SYNTHESIS_FLOOR).sort((a, b) => b.card.relevance_score - a.card.relevance_score);
  if (candidates.length === 0) throw new Error(`No articles scored at least ${SYNTHESIS_FLOOR}`);

  const synthesisResult = await synthesizeEntries(candidates, config, log);
  totalInputTokens += synthesisResult.inputTokens;
  totalOutputTokens += synthesisResult.outputTokens;
  const clusterIds = new Set(synthesisResult.synthesis.clusters.flatMap((cluster) => cluster.source_ids));

  const entries = analyzedEntries.filter(({ article, card }) => (
    card.relevance_score >= MIN_RELEVANCE_SCORE
    || (card.relevance_score >= SYNTHESIS_FLOOR && clusterIds.has(String(article.id)))
  )).sort((a, b) => b.card.relevance_score - a.card.relevance_score);

  const finalIds = new Set(entries.map(({ article }) => String(article.id)));
  const finalSynthesis = {
    clusters: synthesisResult.synthesis.clusters
      .map((cluster) => ({ ...cluster, source_ids: cluster.source_ids.filter((id) => finalIds.has(id)) }))
      .filter((cluster) => cluster.source_ids.length > 0),
  };

  const skippedEntries = analyzedEntries.filter(({ article }) => !finalIds.has(String(article.id)));
  for (const { article, card } of skippedEntries) {
    log.push(`Filtered article ${article.id}: score=${card.relevance_score}, type=${card.signal_type}`);
    updateArticleStatus(article.id, 'ignored');
  }
  if (entries.length === 0 || finalSynthesis.clusters.length === 0) throw new Error('No supported clusters remained after synthesis');

  log.push(`Synthesized ${finalSynthesis.clusters.length} clusters from ${candidates.length} candidates; included=${entries.length}`);
  const digestContent = buildDigest(entries, finalSynthesis, config, skippedEntries.length);
  const today = new Date().toISOString().slice(0, 10);
  const digestId = createDigest({ date: today, part: 1, articlesCount: entries.length });

  const pricing = priceFor(config.claudeModel);
  let costUsd = null;
  if (pricing) {
    const rawCost = (totalInputTokens / 1e6) * pricing.input + (totalOutputTokens / 1e6) * pricing.output;
    costUsd = Math.round(rawCost * 1e6) / 1e6;
  }

  log.push(`Tokens: in=${totalInputTokens} out=${totalOutputTokens} | Model: ${config.claudeModel} | fact-first=true | candidates=${candidates.length} included=${entries.length} filtered=${skippedEntries.length}`);
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
