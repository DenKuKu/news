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
  'textile', 'fabric', 'upholstery', 'upholstered', 'velvet', 'velour',
  'boucle', 'bouclé', 'jacquard', 'chenille', 'microfiber', 'cushion',
  'pillow', 'curtain', 'drapery', 'soft furnishing', 'interior textile',
  'printed fabric', 'printed textile', 'fabric print', 'textile print',
  'patterned upholstery',
];

const FURNITURE_KEYWORDS = [
  'sofa', 'armchair', 'chair', 'seating', 'headboard', 'ottoman', 'pouf',
  'bench', 'furniture',
];

const TREND_KEYWORDS = [
  'pattern', 'ornament', 'colour', 'color', 'colourful', 'colorful',
  'maximalist', 'accent', 'statement', 'custom', 'personalised',
  'personalized', 'bespoke', 'limited edition', 'interior', 'decor',
];

const INNOVATION_KEYWORDS = [
  'collection', 'launches', 'released', 'reimagined', 'contemporary',
  'modular', 'portable', 'adaptable', 'flexible', 'customisable',
  'customizable', 'bespoke', 'limited edition', 'design week',
  'new designers',
];

const DECOR_OBJECT_KEYWORDS = [
  'room divider', 'dividing screen', 'screen', 'decorative panel',
  'wall panel', 'rug', 'carpet', 'wallpaper', 'wallcovering', 'curtain',
  'cushion', 'pillow', 'tapestry', 'textile art',
];

const NON_TEXTILE_PRINTING = [
  '3d-printed', '3d printed', 'printed plastic', 'concrete printing',
  '3d printing',
];

const NON_TEXTILE_MATERIAL_TITLE_KEYWORDS = ['metal materiality'];

const NEGATIVE_KEYWORDS = [
  'stadium', 'airport', 'train terminal', 'railway station', 'bridge',
  'skyscraper', 'office tower', 'school', 'university', 'hospital',
  'infrastructure',
];

const TEXTURALAB_TECH_KEYWORDS = [
  'digital textile printing', 'textile printing', 'fabric printing',
  'digital printing', 'sublimation', 'sublimation printing',
  'transfer printing', 'inkjet printing', 'pigment printing', 'dyeing',
  'dye', 'finishing', 'textile finishing', 'textile processing',
  'coating', 'impregnation', 'water repellent', 'flame retardant',
  'stenter', 'stentering', 'heat setting', 'heat-set', 'thermosol',
  'padding', 'polyester', 'disperse dye', 'coloration', 'colouration',
];

const INDUSTRIAL_PRIORITY_TITLE_KEYWORDS = [
  'kornit',
  'atlas max',
  'brückner',
  'bruckner',
  'eliar',
  'resil chemicals',
];

const PATTERN_DESIGN_KEYWORDS = [
  'surface pattern', 'surface design', 'textile design', 'pattern design',
  'print design', 'repeat pattern', 'repeating pattern', 'repeat', 'repeats',
  'motif', 'colour palette', 'color palette', 'print trend', 'pattern trend',
];

const PATTERN_NOISE_KEYWORDS = [
  'licensing', 'license', 'pricing', 'price your', 'negotiate', 'course',
  'workshop', 'class', 'career', 'portfolio', 'body of work', 'amplifier',
  'how to transfer', 'tutorial',
];

const INTERIOR_STRONG_TREND_KEYWORDS = [
  'quiet luxury', 'playful pattern', 'playful patterns', 'pattern trend',
  'colour trend', 'color trend', 'brown', 'maximalism', 'maximalist',
  'print', 'prints', 'pattern', 'patterns', 'milan', 'design week',
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

function keywordMatches(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => keywordMatches(text, keyword));
}

function relevanceScore(title, content, sourceHostname = '') {
  const normalizedTitle = String(title || '').toLowerCase();
  const normalizedContent = String(content || '').toLowerCase();
  const fullText = `${normalizedTitle} ${normalizedContent}`;

  const host = String(sourceHostname || '')
    .toLowerCase()
    .replace(/^www\./, '');

  const industrialTextileSources = [
    'textilegence.com',
    'textileworld.com',
    'indiantextilemagazine.in',
  ];
  const patternSources = ['patternobserver.com'];
  const interiorSources = [
    'dezeen.com',
    'theinteriorsaddict.com',
    'interiordesign.net',
  ];

  const isIndustrialTextileSource = industrialTextileSources.includes(host);
  const isPatternSource = patternSources.includes(host);
  const isInteriorSource = interiorSources.includes(host);

  const hasCoreTextile = includesAny(fullText, CORE_TEXTILE_KEYWORDS);
  const hasFurniture = includesAny(fullText, FURNITURE_KEYWORDS);
  const hasTrend = includesAny(fullText, TREND_KEYWORDS);
  const hasInnovation = includesAny(fullText, INNOVATION_KEYWORDS);
  const hasDecorObject = includesAny(fullText, DECOR_OBJECT_KEYWORDS);

  const hasTexturaLabTechTitle =
    includesAny(normalizedTitle, TEXTURALAB_TECH_KEYWORDS);
  const hasIndustrialPriorityTitle =
    includesAny(normalizedTitle, INDUSTRIAL_PRIORITY_TITLE_KEYWORDS);

  const hasPatternDesign = includesAny(fullText, PATTERN_DESIGN_KEYWORDS);
  const hasPatternNoise = includesAny(normalizedTitle, PATTERN_NOISE_KEYWORDS);
  const hasStrongInteriorTrend =
    includesAny(normalizedTitle, INTERIOR_STRONG_TREND_KEYWORDS);

  const hasNonTextilePrinting = includesAny(fullText, NON_TEXTILE_PRINTING);
  const hasNonTextileMaterialTitle =
    includesAny(normalizedTitle, NON_TEXTILE_MATERIAL_TITLE_KEYWORDS);

  if (hasNonTextilePrinting && !hasCoreTextile) return -10;
  if (hasNonTextileMaterialTitle && !hasCoreTextile) return -10;
  if (includesAny(normalizedTitle, NEGATIVE_KEYWORDS)) return -10;

  if (isIndustrialTextileSource) {
    const usefulIndustrialSignal =
      hasTexturaLabTechTitle ||
      hasIndustrialPriorityTitle ||
      (hasCoreTextile && hasFurniture) ||
      (hasCoreTextile && hasDecorObject);

    if (!usefulIndustrialSignal) return -5;
  }

  if (isInteriorSource) {
    const usefulInteriorSignal =
      hasCoreTextile ||
      hasStrongInteriorTrend ||
      (hasFurniture && (hasTrend || hasInnovation)) ||
      (hasDecorObject && hasTrend);

    if (!usefulInteriorSignal) return -5;
  }

  if (isPatternSource) {
    if (hasPatternNoise) return -5;

    const usefulPatternSignal =
      hasPatternDesign || hasTrend || hasCoreTextile;

    if (!usefulPatternSignal) return -5;
  }

  let score = 0;

  for (const keyword of CORE_TEXTILE_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 6;
    else if (keywordMatches(normalizedContent, keyword)) score += 3;
  }

  for (const keyword of TEXTURALAB_TECH_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 8;
    else if (keywordMatches(normalizedContent, keyword)) score += 4;
  }

  for (const keyword of FURNITURE_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 4;
    else if (keywordMatches(normalizedContent, keyword)) score += 2;
  }

  for (const keyword of DECOR_OBJECT_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 4;
    else if (keywordMatches(normalizedContent, keyword)) score += 2;
  }

  for (const keyword of TREND_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 3;
    else if (keywordMatches(normalizedContent, keyword)) score += 1;
  }

  for (const keyword of INNOVATION_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 3;
    else if (keywordMatches(normalizedContent, keyword)) score += 1;
  }

  for (const keyword of PATTERN_DESIGN_KEYWORDS) {
    if (keywordMatches(normalizedTitle, keyword)) score += 6;
    else if (keywordMatches(normalizedContent, keyword)) score += 3;
  }

  if (isIndustrialTextileSource && hasTexturaLabTechTitle) score += 4;
  if (isIndustrialTextileSource && hasIndustrialPriorityTitle) score += 8;

  if (
    isInteriorSource &&
    ((hasFurniture && hasTrend) || (hasDecorObject && hasTrend))
  ) {
    score += 4;
  }

  if (isPatternSource && hasPatternDesign) score += 4;
  if (isInteriorSource && hasStrongInteriorTrend) score += 8;

  return score;
}

async function main() {
  initDb(config.dbPath);

  console.log(`[rss] Загружаем: ${feedValidation.href}`);

  const feed = await parser.parseURL(feedValidation.href);
  const items = Array.isArray(feed.items) ? feed.items.slice(0, limit) : [];

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

    const sourceHostname = new URL(articleValidation.href).hostname;
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

    const score = relevanceScore(title, content, sourceHostname);
    const minimumScore = 8;

    if (score < minimumScore) {
      skipped++;
      console.log(
        `[rss] Не по теме (${score}, порог ${minimumScore}): ${title}`
      );
      continue;
    }

    console.log(`[rss] Релевантность ${score}: ${title}`);

    const publishedAt = item.isoDate || item.pubDate || '';
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
