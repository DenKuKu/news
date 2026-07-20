import Parser from 'rss-parser';

import config from '../src/config.js';
import { initDb, insertArticle } from '../src/db/index.js';
import { validateArticleUrl } from '../src/services/url-validator.js';

const feedUrl = process.argv[2];
const requestedLimit = Number.parseInt(process.argv[3] || '10', 10);

const limit = Number.isFinite(requestedLimit)
  ? Math.min(Math.max(requestedLimit, 1), 50)
  : 10;

if (!feedUrl) {
  console.error(
    'Укажите RSS URL.\n' +
    'Пример:\n' +
    'node scripts/import-rss.js "https://www.dezeen.com/feed/" 10'
  );
  process.exit(1);
}

const feedValidation = validateArticleUrl(feedUrl);

if (!feedValidation.ok) {
  console.error(`RSS URL отклонён: ${feedValidation.error}`);
  process.exit(1);
}

const parser = new Parser({
  timeout: 20_000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    Accept:
      'application/rss+xml, application/atom+xml, application/xml, ' +
      'text/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
  },
});

const CORE_TEXTILE_KEYWORDS = [
  'textile',
  'fabric',
  'upholstery',
  'upholstered',
  'velvet',
  'velour',
  'boucle',
  'bouclé',
  'jacquard',
  'chenille',
  'microfiber',
  'cushion',
  'pillow',
  'curtain',
  'drapery',
  'soft furnishing',
  'interior textile',
  'printed fabric',
  'printed textile',
  'fabric print',
  'textile print',
  'patterned upholstery',
];

const FURNITURE_KEYWORDS = [
  'sofa',
  'armchair',
  'chair',
  'seating',
  'headboard',
  'ottoman',
  'pouf',
  'bench',
  'furniture',
];

const TREND_KEYWORDS = [
  'pattern',
  'ornament',
  'colour',
  'color',
  'colourful',
  'colorful',
  'maximalist',
  'accent',
  'statement',
  'custom',
  'personalised',
  'personalized',
  'bespoke',
  'limited edition',
  'interior',
  'decor',
];
const INNOVATION_KEYWORDS = [
  'collection',
  'launches',
  'released',
  'reimagined',
  'contemporary',
  'modular',
  'portable',
  'adaptable',
  'flexible',
  'customisable',
  'customizable',
  'bespoke',
  'limited edition',
  'design week',
  'new designers',
];

const DECOR_OBJECT_KEYWORDS = [
  'room divider',
  'dividing screen',
  'screen',
  'decorative panel',
  'wall panel',
  'rug',
  'carpet',
  'wallpaper',
  'wallcovering',
  'curtain',
  'cushion',
  'pillow',
  'tapestry',
  'textile art',
];
const NON_TEXTILE_PRINTING = [
  '3d-printed',
  '3d printed',
  'printed plastic',
  'concrete printing',
  '3d printing',
];

const NEGATIVE_KEYWORDS = [
  'stadium',
  'airport',
  'train terminal',
  'railway station',
  'bridge',
  'skyscraper',
  'office tower',
  'school',
  'university',
  'hospital',
  'infrastructure',
];

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function relevanceScore(title, content) {
  const normalizedTitle = String(title || '').toLowerCase();
  const normalizedContent = String(content || '').toLowerCase();
  const fullText = `${normalizedTitle} ${normalizedContent}`;

  const hasCoreTextile = includesAny(fullText, CORE_TEXTILE_KEYWORDS);
  const hasFurniture = includesAny(fullText, FURNITURE_KEYWORDS);
  const hasTrend = includesAny(fullText, TREND_KEYWORDS);
  const hasInnovation = includesAny(fullText, INNOVATION_KEYWORDS);
  const hasDecorObject = includesAny(fullText, DECOR_OBJECT_KEYWORDS);
  const hasNonTextilePrinting = includesAny(
    fullText,
    NON_TEXTILE_PRINTING
  );

  // Пластик, бетон и предметная 3D-печать нам не подходят,
  // если материал не связан с текстилем.
  if (hasNonTextilePrinting && !hasCoreTextile) {
    return -10;
  }

  // Отрицательные признаки учитываем только в заголовке.
  // Иначе слово university или school в подписи автора
  // может ошибочно уничтожить хорошую мебельную новость.
  if (includesAny(normalizedTitle, NEGATIVE_KEYWORDS)) {
    return -10;
  }

  let score = 0;

  for (const keyword of CORE_TEXTILE_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) score += 10;
    else if (normalizedContent.includes(keyword)) score += 5;
  }

  for (const keyword of FURNITURE_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) score += 4;
    else if (normalizedContent.includes(keyword)) score += 2;
  }

  for (const keyword of DECOR_OBJECT_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) score += 4;
    else if (normalizedContent.includes(keyword)) score += 2;
  }

  for (const keyword of TREND_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) score += 3;
    else if (normalizedContent.includes(keyword)) score += 1;
  }

  for (const keyword of INNOVATION_KEYWORDS) {
    if (normalizedTitle.includes(keyword)) score += 3;
    else if (normalizedContent.includes(keyword)) score += 1;
  }

  // Основной текстиль принимаем всегда.
  if (hasCoreTextile) {
    return Math.max(score, 6);
  }

  // Мебель принимаем, если есть дизайнерский или продуктовый сигнал.
  if (hasFurniture && (hasTrend || hasInnovation)) {
    return score;
  }

  // Декоративные предметы — только при наличии трендового контекста.
  if (hasDecorObject && hasTrend) {
    return score;
  }

  return -5;
}

async function main() {
  initDb(config.dbPath);

  console.log(`[rss] Загружаем: ${feedValidation.href}`);

  const feed = await parser.parseURL(feedValidation.href);
  const items = Array.isArray(feed.items)
    ? feed.items.slice(0, limit)
    : [];

  console.log(`[rss] Лента: ${feed.title || 'без названия'}`);
  console.log(`[rss] Получено элементов: ${items.length}`);

  let inserted = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const item of items) {
    const rawUrl = item.link || item.guid || '';
    const articleValidation = validateArticleUrl(rawUrl);

    if (!articleValidation.ok) {
      skipped++;
      console.log(
        `[rss] Пропуск ссылки: ${rawUrl || '(пусто)'} — ` +
        articleValidation.error
      );
      continue;
    }

    const title = cleanText(item.title);

    const content = cleanText(
      item.contentSnippet ||
      item.content ||
      item.summary ||
      item.description ||
      title
    );

    if (!title && content.length < 40) {
      skipped++;
      console.log(
        `[rss] Пропуск пустого материала: ${articleValidation.href}`
      );
      continue;
    }

    const score = relevanceScore(title, content);

    if (score < 4) {
      skipped++;
      console.log(`[rss] Не по теме (${score}): ${title}`);
      continue;
    }

    console.log(`[rss] Релевантность ${score}: ${title}`);

    const publishedAt = item.isoDate || item.pubDate || '';
    const sourceHostname = new URL(feedValidation.href).hostname;

    const preparedContent = [
      publishedAt ? `Дата публикации: ${publishedAt}` : '',
      content,
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = insertArticle({
      url: articleValidation.href,
      title,
      content: preparedContent,
      source: `rss:${sourceHostname}`,
    });

    if (result.duplicate) {
      duplicates++;
      console.log(`[rss] Уже существует: ${title}`);
    } else {
      inserted++;
      console.log(`[rss] Добавлено: ${title}`);
    }
  }

  console.log('');
  console.log('[rss] Готово');
  console.log(`[rss] Добавлено: ${inserted}`);
  console.log(`[rss] Дубликатов: ${duplicates}`);
  console.log(`[rss] Пропущено: ${skipped}`);
}

main().catch((error) => {
  console.error('[rss] Ошибка импорта:', error);
  process.exit(1);
});