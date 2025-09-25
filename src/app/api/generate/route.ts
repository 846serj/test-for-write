// route.ts
import { NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import { DEFAULT_WORDS, WORD_RANGES } from '../../../constants/lengthOptions';
import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';
import { grokChatCompletion } from '../../../lib/grok';

export const runtime = 'edge';
export const revalidate = 0;

type NewsFreshness = '1h' | '6h' | '7d';

interface NewsArticle {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

interface ReportingSource {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

type ReportingContext = {
  reportingSources: ReportingSource[];
  reportingBlock: string;
  groundingInstruction: string;
  linkSources: string[];
  referenceBlock: string;
};

type VerificationSource =
  | string
  | {
      url?: string | null;
      title?: string | null;
      summary?: string | null;
      publishedAt?: string | null;
    };

const FRESHNESS_TO_HOURS: Record<NewsFreshness, number> = {
  '1h': 1,
  '6h': 6,
  '7d': 24 * 7,
};

const MILLIS_IN_MINUTE = 60 * 1000;
const MILLIS_IN_HOUR = 60 * MILLIS_IN_MINUTE;
const MILLIS_IN_DAY = 24 * MILLIS_IN_HOUR;
const MILLIS_IN_WEEK = 7 * MILLIS_IN_DAY;
const RELATIVE_TIME_UNIT_MS: Record<string, number> = {
  m: MILLIS_IN_MINUTE,
  min: MILLIS_IN_MINUTE,
  mins: MILLIS_IN_MINUTE,
  minute: MILLIS_IN_MINUTE,
  minutes: MILLIS_IN_MINUTE,
  h: MILLIS_IN_HOUR,
  hr: MILLIS_IN_HOUR,
  hrs: MILLIS_IN_HOUR,
  hour: MILLIS_IN_HOUR,
  hours: MILLIS_IN_HOUR,
  d: MILLIS_IN_DAY,
  day: MILLIS_IN_DAY,
  days: MILLIS_IN_DAY,
  w: MILLIS_IN_WEEK,
  week: MILLIS_IN_WEEK,
  weeks: MILLIS_IN_WEEK,
  mo: 30 * MILLIS_IN_DAY,
  mos: 30 * MILLIS_IN_DAY,
  month: 30 * MILLIS_IN_DAY,
  months: 30 * MILLIS_IN_DAY,
  y: 365 * MILLIS_IN_DAY,
  yr: 365 * MILLIS_IN_DAY,
  yrs: 365 * MILLIS_IN_DAY,
  year: 365 * MILLIS_IN_DAY,
  years: 365 * MILLIS_IN_DAY,
};

const MAX_SOURCE_WINDOW_MS = 14 * MILLIS_IN_DAY;
const MAX_FUTURE_DRIFT_MS = 5 * MILLIS_IN_MINUTE;

const sectionRanges: Record<string, [number, number]> = {
  shorter: [2, 4],
  short: [3, 5],
  medium: [4, 6],
  longForm: [5, 7],
  longer: [6, 8],
};

function normalizeTitleValue(title: string | undefined | null): string {
  const holder = normalizeTitleValue as unknown as {
    _publisherData?: {
      knownWords: Set<string>;
      knownExact: Set<string>;
    };
  };

  if (!holder._publisherData) {
    holder._publisherData = {
      knownWords: new Set([
        'news',
        'times',
        'post',
        'journal',
        'tribune',
        'guardian',
        'gazette',
        'review',
        'report',
        'chronicle',
        'daily',
        'herald',
        'press',
        'today',
        'insider',
        'bloomberg',
        'reuters',
        'axios',
        'politico',
        'verge',
        'engadget',
        'techcrunch',
        'wired',
        'cnbc',
        'cnn',
        'bbc',
        'cbs',
        'abc',
        'fox',
        'fortune',
        'forbes',
        'npr',
        'yahoo',
        'ap',
        'barron',
        "barron's",
        'wsj',
        'telegraph',
        'independent',
        'register',
        'observer',
        'courier',
        'star',
        'globe',
        'sun',
        'mirror',
        'economist',
        'financial',
      ]),
      knownExact: new Set([
        'new york times',
        'washington post',
        'wall street journal',
        'associated press',
        'financial times',
        'usa today',
        'los angeles times',
        'la times',
        'business insider',
        'the verge',
        'the guardian',
        'the atlantic',
        'the economist',
        'sky news',
        'cnet',
        'buzzfeed news',
      ]),
    };
  }

  const { knownWords, knownExact } = holder._publisherData;

  function isLikelyPublisherSegment(segment: string): boolean {
    const trimmed = segment.trim();
    if (!trimmed) return false;

    const stripped = trimmed.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
    if (!stripped) return false;

    const lowered = stripped.toLowerCase();
    if (knownExact.has(lowered)) {
      return true;
    }

    if (lowered.includes('.com') || lowered.includes('.net') || lowered.includes('.org')) {
      return true;
    }

    const loweredWords = lowered.split(/\s+/);
    if (loweredWords.length === 0 || loweredWords.length > 6) {
      return false;
    }

    if (loweredWords.some((word) => knownWords.has(word))) {
      return true;
    }

    const originalWords = trimmed.split(/\s+/);
    let alphaWordCount = 0;
    let titleCasedCount = 0;

    for (const word of originalWords) {
      if (!/[A-Za-z]/.test(word)) {
        continue;
      }
      alphaWordCount += 1;

      if (word === word.toUpperCase()) {
        titleCasedCount += 1;
        continue;
      }

      const first = word.charAt(0);
      const rest = word.slice(1);
      if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
        titleCasedCount += 1;
      }
    }

    if (alphaWordCount > 0 && titleCasedCount >= alphaWordCount - 1) {
      return true;
    }

    return false;
  }

  let normalized = (title ?? '').trim();
  const trailingSeparatorRegex = /\s*[\-–—|]\s*([^\-–—|]+)$/;

  while (true) {
    const match = normalized.match(trailingSeparatorRegex);
    if (!match) {
      break;
    }

    const segment = match[1]?.trim() ?? '';
    if (!segment) {
      break;
    }

    if (!isLikelyPublisherSegment(segment)) {
      break;
    }

    normalized = normalized.slice(0, normalized.length - match[0].length).trimEnd();
  }

  normalized = normalized.replace(/[\s]*[\-–—|:;,]+$/g, '').trim();

  return normalized.toLowerCase().replace(/\s+/g, ' ');
}

function getWordBounds(
  lengthOption: string | undefined,
  customSections: number | undefined
): [number, number] {
  if (lengthOption === 'custom' && customSections) {
    const approx = customSections * 220;
    return [Math.floor(approx * 0.8), Math.ceil(approx * 1.2)];
  }
  if (lengthOption && WORD_RANGES[lengthOption]) {
    return WORD_RANGES[lengthOption];
  }
  return [DEFAULT_WORDS - 150, DEFAULT_WORDS + 150];
}


// Minimum number of source links to include in generated content
const MIN_LINKS = 3;
const STRICT_LINK_RETRY_THRESHOLD = 2;
const VERIFICATION_DISCREPANCY_THRESHOLD = 0;
const VERIFICATION_MAX_SOURCE_FIELD_LENGTH = 600;
const VERIFICATION_MAX_SOURCES = 8;
const VERIFICATION_TIMEOUT_MS = 25_000;

// Low temperature to encourage factual consistency for reporting prompts
const FACTUAL_TEMPERATURE = 0.2;

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

// Encourage more concrete examples by default
const DETAIL_INSTRUCTION =
  '- Provide specific real-world examples (e.g., car model years or actual app names) instead of generic placeholders like "App 1".\n' +
  '- When sources include concrete facts, repeat them precisely: list full names, state exact dates with month/day/year, give unrounded figures, and preserve other specific details.\n' +
  '- Keep official names, model numbers, and other exact designations verbatim when they appear in the sources (e.g., "IL-20" instead of "plane").\n' +
  '- When summarizing, never replace explicit metrics, named individuals, or timelines with vague substitutes such as "many", "recently", or "officials"—quote the exact figures, dates, and proper nouns provided.\n' +
  '- Do not speculate or embellish beyond what the sources explicitly provide.\n' +
  '- Treat every "Key details" line in the reporting block as mandatory: restate those exact metrics, names, and timelines in the article body and attribute them to the correct source with an inline citation.\n' +
  '- Each paragraph that introduces a factual statement must contain at least one inline citation tied to a concrete detail such as a number, date, named person, organization, or location, and paragraphs covering multiple facts should cite each one individually.\n' +
  '- When outlining developments over time, pair each milestone with the exact date or timeframe reported in the sources (e.g., "on March 3, 2024") and cite it inline.\n' +
  '- Enumerate every figure, location, and named stakeholder the sources mention instead of collapsing them into a single vague summary—spell them out verbatim and cite them inline.\n' +
  '- Explicitly reference the titles or roles that identify key people or organizations when the sources provide them, and cite the matching link.\n' +
  '- When a source explains impact or stakes (e.g., job losses, funding amounts, geographic coverage), restate those outcomes verbatim with citations rather than summarizing them abstractly.\n' +
  '- Treat the outline as a factual checklist: every specific name, title, figure, location, quote, and date it contains must appear in the article body with identical wording and an inline citation to the same source noted in the outline.\n' +
  '- If the outline introduction bullet includes concrete facts, repeat them in the article introduction with the same explicit data points and citations instead of replacing them with generic framing.\n' +
  '- If a potentially important fact cannot be verified in the provided sources, omit it and instead note "Unverified based on available sources."\n';

const TIMELINE_REGEX =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,\s*\d{4})?\b/gi;
const QUARTER_REGEX = /\b(?:Q[1-4]|H[12])\s*(?:\d{4})?\b/gi;
const ISO_DATE_REGEX = /\b\d{4}[-\/](?:0?[1-9]|1[0-2])[-\/](?:0?[1-9]|[12]\d|3[01])\b/g;
const YEAR_WITH_CONTEXT_REGEX = /\b(?:in|by|during|through|since|from)\s+(19\d{2}|20\d{2})\b/gi;
const NUMERIC_METRIC_REGEX =
  /(?:[$£€]\s?)?\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b(?:\s?(?:%|percent|percentage|pp|basis points|people|patients|respondents|cases|votes|points|miles|mile|kilometers|kilometres|km|meters|metres|m|kilograms|kg|grams|g|pounds|lbs|°f|°c|usd|dollars|euros|pounds|yen|yuan|won|rupees|million|billion|trillion|k|units|devices|users|students|employees|samples|tests|surveys|mg|ml|gwh|mwh|kw|mw|gw|tons|tonnes|barrels|gallons|liters|litres|ppm|ppb|per\s+capita|per\s+share|per\s+day|per\s+hour))?/gi;
const METHOD_KEYWORDS = [
  'randomized controlled trial',
  'double-blind trial',
  'placebo-controlled trial',
  'longitudinal study',
  'cross-sectional study',
  'pilot study',
  'observational study',
  'clinical trial',
  'survey',
  'poll',
  'census',
  'analysis',
  'benchmark',
  'simulation',
  'prototype',
  'sensor',
  'algorithm',
  'dataset',
  'measurement',
  'sampling',
  'methodology',
  'technique',
  'audit',
  'assessment',
  'evaluation',
  'regression model',
  'machine learning model',
  'laboratory test',
  'peer-reviewed'
];
const ENTITY_STOPWORDS = new Set([
  'Recent',
  'Reporting',
  'Summary',
  'URL',
  'The',
  'A',
  'An',
  'And',
  'For',
  'With',
  'From',
  'This',
  'That',
  'These',
  'Those',
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]);

interface StructuredFacts {
  metrics: string[];
  timelines: string[];
  methods: string[];
  entities: string[];
}

function dedupeDetails(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractMethodPhrases(text: string): string[] {
  if (!text) {
    return [];
  }
  const lowered = text.toLowerCase();
  const phrases: string[] = [];
  for (const keyword of METHOD_KEYWORDS) {
    const index = lowered.indexOf(keyword);
    if (index === -1) {
      continue;
    }
    const snippet = text.slice(index, index + keyword.length);
    phrases.push(snippet);
  }
  return phrases;
}

function extractProperNouns(text: string): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(/\b(?:[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|of|and|the|for|de|la|di|van|von|da|der|del|du|le))*|[A-Z]{3,})\b/g);
  if (!matches) {
    return [];
  }
  const filtered = matches.filter((match) => {
    const cleaned = match.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return false;
    }
    if (ENTITY_STOPWORDS.has(cleaned)) {
      return false;
    }
    const wordCount = cleaned.split(/\s+/g).length;
    if (wordCount === 1) {
      if (/^[A-Z]{3,}$/.test(cleaned)) {
        return true;
      }
      if (/^[A-Z][a-z]+(?:['-][A-Za-z]+)?$/.test(cleaned) && cleaned.length > 2) {
        return true;
      }
      return false;
    }
    return true;
  });
  return filtered;
}

function collectMetricTokens(text: string): string[] {
  if (!text) {
    return [];
  }
  const metrics: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = NUMERIC_METRIC_REGEX.exec(text))) {
    let token = match[0];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 30);
    const hyphenMatch = after.match(/^-[A-Za-z]+(?:-[A-Za-z]+)?/);
    if (hyphenMatch) {
      token += hyphenMatch[0];
    }
    const perMatch = after.match(/^\s+(?:per|each)\s+[A-Za-z%°/$-]+/i);
    if (perMatch) {
      token += perMatch[0];
    }
    metrics.push(token);
  }
  const currencyMatches = text.match(/[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*(?:million|billion|trillion))?/gi);
  if (currencyMatches) {
    metrics.push(...currencyMatches);
  }
  return metrics;
}

function collectTimelineTokens(text: string): string[] {
  if (!text) {
    return [];
  }
  const timelines: string[] = [];
  const monthMatches = text.match(TIMELINE_REGEX);
  if (monthMatches) {
    timelines.push(...monthMatches);
  }
  const quarterMatches = text.match(QUARTER_REGEX);
  if (quarterMatches) {
    timelines.push(...quarterMatches);
  }
  const isoMatches = text.match(ISO_DATE_REGEX);
  if (isoMatches) {
    timelines.push(...isoMatches);
  }
  let contextualMatch: RegExpExecArray | null;
  while ((contextualMatch = YEAR_WITH_CONTEXT_REGEX.exec(text))) {
    timelines.push(contextualMatch[0]);
  }
  return timelines;
}

function extractStructuredFacts(summary: string | undefined | null): StructuredFacts {
  if (!summary) {
    return { metrics: [], timelines: [], methods: [], entities: [] };
  }
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized || /^no summary provided\.?$/i.test(normalized)) {
    return { metrics: [], timelines: [], methods: [], entities: [] };
  }

  const metrics = dedupeDetails(collectMetricTokens(normalized), 6);
  const timelinesRaw = collectTimelineTokens(normalized);
  const timelines = dedupeDetails(timelinesRaw, 5);
  const methods = dedupeDetails(extractMethodPhrases(normalized), 4);
  const entities = dedupeDetails(extractProperNouns(normalized), 6);

  const timelineSet = new Set(timelines.map((item) => item.toLowerCase()));
  const filteredMetrics = metrics.filter((item) => !timelineSet.has(item.toLowerCase()));
  const refinedMetrics = filteredMetrics.filter((item) => {
    const numeric = item.replace(/[^0-9.]/g, '');
    if (!numeric) {
      return true;
    }
    const numericValue = Number.parseFloat(numeric);
    if (!Number.isFinite(numericValue)) {
      return true;
    }
    if (Number.isInteger(numericValue) && numericValue <= 31 && item.replace(/[^0-9]/g, '').length <= 2) {
      return false;
    }
    return true;
  });

  return {
    metrics: refinedMetrics,
    timelines,
    methods,
    entities,
  };
}

function formatKeyDetails(summary: string | undefined | null): string[] {
  const facts = extractStructuredFacts(summary);
  const segments: string[] = [];
  if (facts.metrics.length) {
    segments.push(`Cite these metrics verbatim: ${facts.metrics.join(', ')}`);
  }
  if (facts.timelines.length) {
    segments.push(`State these reported timelines exactly: ${facts.timelines.join(', ')}`);
  }
  if (facts.methods.length) {
    segments.push(`Reference the research methods noted: ${facts.methods.join('; ')}`);
  }
  if (facts.entities.length) {
    segments.push(`Name these entities precisely: ${facts.entities.join(', ')}`);
  }
  return segments;
}

async function generateOutlineWithGrokFallback(
  prompt: string,
  fallbackModel: string,
  temperature = 0.7
): Promise<string> {
  if (process.env.GROK_API_KEY) {
    try {
      return await grokChatCompletion({ prompt, temperature });
    } catch (err) {
      console.warn('[api/generate] grok outline generation failed, falling back to OpenAI', err);
    }

  }

  const outlineRes = await openai.chat.completions.create({
    model: fallbackModel,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  });

  const outline = outlineRes.choices[0]?.message?.content?.trim();
  if (!outline) throw new Error('Outline generation failed');
  return outline;
}

function calcMaxTokens(
  lengthOption: string | undefined,
  customSections: number | undefined,
  model: string
): number {
  let desiredWords: number;
  if (lengthOption === 'custom' && customSections) {
    desiredWords = customSections * 220;
  } else if (lengthOption && WORD_RANGES[lengthOption]) {
    const [minW, maxW] = WORD_RANGES[lengthOption];
    desiredWords = (minW + maxW) / 2;
  } else {
    desiredWords = DEFAULT_WORDS;
  }
  const tokens = Math.ceil(desiredWords / 0.75);
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  return Math.min(tokens, limit);
}

async function fetchSources(
  headline: string,
  freshness?: NewsFreshness
): Promise<ReportingSource[]> {
  const resolvedFreshness = resolveFreshness(freshness);
  const nowMs = Date.now();
  const seenLinks = new Set<string>();
  const seenPublishers = new Set<string>();
  const seenTitles = new Set<string>();
  const candidateSources: ReportingSource[] = [];

  const newsPromise: Promise<NewsArticle[]> = process.env.NEWS_API_KEY
    ? fetchNewsArticles(headline, resolvedFreshness, false).catch((err) => {
        console.warn(
          '[api/generate] news api sourcing failed, continuing with SERP',
          err
        );
        return [];
      })
    : Promise.resolve([]);

  const serpPromise = serpapiSearch({
    query: headline,
    engine: 'google_news',
    extraParams: { tbs: mapFreshnessToSerpTbs(resolvedFreshness) },
    limit: 8,
  });

  const [newsArticles, serpResults] = await Promise.all([
    newsPromise,
    serpPromise,
  ]);

  for (const article of newsArticles) {
    const url = article.url;
    const normalizedTitle = normalizeTitleValue(article.title);
    if (!url || seenLinks.has(url)) {
      continue;
    }

    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      continue;
    }

    const publishedTimestamp = parsePublishedTimestamp(article.publishedAt, nowMs);
    if (publishedTimestamp === null || !isTimestampWithinWindow(publishedTimestamp, nowMs)) {
      continue;
    }

    let publisherId: string | null = null;
    try {
      publisherId = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      publisherId = null;
    }

    if (publisherId && seenPublishers.has(publisherId)) {
      continue;
    }

    const summary = (article.summary || '').replace(/\s+/g, ' ').trim();
    const reportingSource: ReportingSource = {
      title: article.title || 'Untitled',
      url,
      summary,
      publishedAt: normalizePublishedAt(publishedTimestamp),
    };

    candidateSources.push(reportingSource);

    seenLinks.add(url);
    if (publisherId) {
      seenPublishers.add(publisherId);
    }
    if (normalizedTitle) {
      seenTitles.add(normalizedTitle);
    }
  }

  for (const result of serpResults) {
    const normalizedTitle = normalizeTitleValue(result.title);
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      continue;
    }

    const link = result.link;
    if (!link || seenLinks.has(link)) {
      continue;
    }

    const publisherId = normalizePublisher(result);
    if (!publisherId || seenPublishers.has(publisherId)) {
      continue;
    }

    const summary = (result.snippet || result.summary || '')
      .replace(/\s+/g, ' ')
      .trim();
    const publishedAtRaw =
      result.published_at || result.date_published || result.date || '';
    const publishedTimestamp = parsePublishedTimestamp(publishedAtRaw, nowMs);
    if (publishedTimestamp === null || !isTimestampWithinWindow(publishedTimestamp, nowMs)) {
      continue;
    }
    const title = result.title || 'Untitled';

    seenLinks.add(link);
    seenPublishers.add(publisherId);
    if (normalizedTitle) {
      seenTitles.add(normalizedTitle);
    }

    candidateSources.push({
      title,
      url: link,
      summary,
      publishedAt: normalizePublishedAt(publishedTimestamp),
    });
  }

  if (!candidateSources.length) {
    return [];
  }

  return candidateSources.slice(0, 5);
}

function formatPublishedTimestamp(value: string): string {
  if (!value) {
    return 'Unknown publication time';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown publication time';
  }
  return date.toISOString();
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.replace(/\s+/g, ' ').trim();
  return trimmed || 'No summary provided.';
}

function buildRecentReportingBlock(sources: ReportingSource[]): string {
  if (!sources.length) {
    return '';
  }

  const entries = sources
    .map((item) => {
      const timestamp = formatPublishedTimestamp(item.publishedAt);
      const summary = normalizeSummary(item.summary);
      const keyDetails = formatKeyDetails(item.summary);
      const title = item.title || 'Untitled';
      const detailLine =
        keyDetails.length > 0
          ? `\n  Must include and cite each item below as a distinct, cited sentence:\n${keyDetails
              .map((detail) => `    - ${detail}`)
              .join('\n')}`
          : '';
      return `- "${title}" (${timestamp})\n  Summary: ${summary}${detailLine}\n  URL: ${item.url}`;
    })
    .join('\n');

  return `Recent reporting to reference:\n${entries}`;
}

function normalizePublisher(result: SerpApiResult): string | null {
  const rawSource = typeof result.source === 'string' ? result.source : '';
  const normalizedSource = rawSource.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedSource) {
    return normalizedSource;
  }

  const link = result.link;
  if (!link) return null;

  try {
    const hostname = new URL(link).hostname.toLowerCase();
    if (!hostname) return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function resolveFreshness(freshness: NewsFreshness | undefined): NewsFreshness {
  if (!freshness) return '6h';
  return freshness;
}

function mapFreshnessToSerpTbs(freshness: NewsFreshness): string {
  if (freshness === '1h') return 'qdr:h';
  if (freshness === '6h') return 'qdr:h6';
  return 'qdr:w';
}

function computeFreshnessIso(freshness: NewsFreshness): string {
  const hours = FRESHNESS_TO_HOURS[freshness] ?? FRESHNESS_TO_HOURS['6h'];
  const from = new Date(Date.now() - hours * 60 * 60 * 1000);
  return from.toISOString();
}

function parseRelativeTimestamp(value: string, referenceMs: number): number | null {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) {
    return null;
  }

  if (cleaned === 'yesterday') {
    return referenceMs - MILLIS_IN_DAY;
  }

  if (cleaned === 'today') {
    return referenceMs;
  }

  const normalized = cleaned.replace(/,/g, '');
  const fullMatch = normalized.match(/^(\d+|an|a)\s*([a-z]+)\s+ago$/);
  const compactMatch = normalized.match(/^(\d+)([a-z]+)\s+ago$/);
  const match = fullMatch ?? compactMatch;
  if (!match) {
    return null;
  }

  const amountRaw = match[1];
  const unitRaw = match[2];
  const amount = amountRaw === 'a' || amountRaw === 'an' ? 1 : Number.parseInt(amountRaw, 10);
  const unitMs = RELATIVE_TIME_UNIT_MS[unitRaw];

  if (!Number.isFinite(amount) || !unitMs) {
    return null;
  }

  return referenceMs - amount * unitMs;
}

function parsePublishedTimestamp(
  raw: string | null | undefined,
  referenceMs: number
): number | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return parseRelativeTimestamp(trimmed, referenceMs);
}

function isTimestampWithinWindow(timestamp: number, referenceMs: number): boolean {
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  if (timestamp > referenceMs + MAX_FUTURE_DRIFT_MS) {
    return false;
  }

  return referenceMs - timestamp <= MAX_SOURCE_WINDOW_MS;
}

function normalizePublishedAt(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function fetchNewsArticles(
  query: string,
  freshness: NewsFreshness | undefined,
  serpFallbackEnabled: boolean
): Promise<NewsArticle[]> {
  const resolvedFreshness = resolveFreshness(freshness);
  const fromIso = computeFreshnessIso(resolvedFreshness);
  const nowMs = Date.now();
  const newsKey = process.env.NEWS_API_KEY;

  const fetchSerpArticles = serpFallbackEnabled && process.env.SERPAPI_KEY
    ? (async (): Promise<NewsArticle[]> => {
        try {
          const freshnessParam = mapFreshnessToSerpTbs(resolvedFreshness);
          const serpResults = await serpapiSearch({
            query,
            engine: 'google_news',
            extraParams: { tbs: freshnessParam },
            limit: 8,
          });

          const seenTitles = new Set<string>();
          const articles: NewsArticle[] = [];

          for (const item of serpResults) {
            const normalizedTitle = normalizeTitleValue(item.title);
            if (normalizedTitle && seenTitles.has(normalizedTitle)) {
              continue;
            }

            const article: NewsArticle = {
              title: item.title || 'Untitled',
              url: item.link || '',
              summary: (item.snippet || '').replace(/\s+/g, ' ').trim(),
              publishedAt: '',
            };

            if (!article.title || !article.url) {
              continue;
            }

            const publishedTimestamp = parsePublishedTimestamp(
              item.published_at || item.date_published || item.date || '',
              nowMs
            );

            if (
              publishedTimestamp === null ||
              !isTimestampWithinWindow(publishedTimestamp, nowMs)
            ) {
              continue;
            }

            article.publishedAt = normalizePublishedAt(publishedTimestamp);

            if (normalizedTitle) {
              seenTitles.add(normalizedTitle);
            }

            articles.push(article);

            if (articles.length >= 8) {
              break;
            }
          }

          return articles;
        } catch (err) {
          console.warn('[api/generate] serpapi fallback failed', err);
          return [];
        }
      })()
    : null;

  if (newsKey) {
    try {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', query);
      url.searchParams.set('from', fromIso);
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', '8');
      const resp = await fetch(url, {
        headers: { 'X-Api-Key': newsKey },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.status === 'ok' && Array.isArray(data.articles)) {
          const parsed = (data.articles as any[])
            .map((article) => {
              const publishedRaw =
                article?.publishedAt || article?.updatedAt || article?.date || '';
              const publishedTimestamp = parsePublishedTimestamp(publishedRaw, nowMs);

              if (
                publishedTimestamp === null ||
                !isTimestampWithinWindow(publishedTimestamp, nowMs)
              ) {
                return null;
              }

              const summaryValue =
                article?.description || article?.content || article?.summary || '';

              const summary = typeof summaryValue === 'string'
                ? summaryValue.replace(/\s+/g, ' ').trim()
                : '';

              const mapped: NewsArticle = {
                title: article?.title || article?.headline || 'Untitled',
                url: article?.url || '',
                summary,
                publishedAt: normalizePublishedAt(publishedTimestamp),
              };

              return mapped.title && mapped.url ? mapped : null;
            })
            .filter((item: NewsArticle | null): item is NewsArticle => Boolean(item));
          if (parsed.length > 0) {
            return parsed.slice(0, 8);
          }
        }
      }
    } catch (err) {
      console.warn('[api/generate] news api fetch failed, falling back to SerpAPI', err);
    }
  }

  if (fetchSerpArticles) {
    return await fetchSerpArticles;
  }

  return [];
}

// Fetch YouTube captions
async function fetchTranscript(videoLink: string): Promise<string> {
  try {
    const urlObj = new URL(videoLink);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) return '';
    const resp = await fetch(
      `https://video.google.com/timedtext?lang=en&v=${videoId}`
    );
    const xml = await resp.text();
    return xml.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Fetch and strip a blog post's HTML
async function fetchBlogContent(blogLink: string): Promise<string> {
  try {
    const resp = await fetch(blogLink);
    const html = await resp.text();
    return html.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Fetch and optionally summarize blog content
async function summarizeBlogContent(
  blogLink: string,
  useSummary: boolean,
  model: string
): Promise<string> {
  const original = await fetchBlogContent(blogLink);
  if (!original) return '';
  if (!useSummary) return original;
  try {
    const prompt = `Summarize the following article in bullet points.\n\n${original}`;
    const res = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 300,
    });
    return res.choices[0]?.message?.content?.trim() || original;
  } catch {
    return original;
  }
}

function normalizeHrefValue(url: string): string {
  return url.replace(/&amp;/g, '&').trim();
}

function buildUrlVariants(url: string): string[] {
  const normalized = normalizeHrefValue(url);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>();
  const addVariant = (value: string | null | undefined) => {
    if (!value) {
      return;
    }
    variants.add(value);
    if (value.endsWith('/')) {
      variants.add(value.slice(0, -1));
    } else {
      variants.add(`${value}/`);
    }
  };

  const normalizePathname = (pathname: string): string => {
    if (!pathname) {
      return '/';
    }
    let result = pathname;
    if (!result.startsWith('/')) {
      result = `/${result}`;
    }
    while (result.length > 1 && result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    return result || '/';
  };

  const addHostPathVariants = (urlObj: URL) => {
    const hostname = urlObj.hostname.toLowerCase();
    if (!hostname) {
      return;
    }
    const normalizedPath = normalizePathname(urlObj.pathname);
    const hostVariants = new Set<string>([hostname]);
    if (hostname.startsWith('www.')) {
      hostVariants.add(hostname.slice(4));
    } else {
      hostVariants.add(`www.${hostname}`);
    }
    for (const host of hostVariants) {
      if (!host) {
        continue;
      }
      variants.add(`hostpath:${host}${normalizedPath}`);
    }
  };

  const globalObj = globalThis as {
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
    atob?: (input: string) => string;
  };

  const decodeBase64 = (value: string): string | null => {
    if (!value) {
      return null;
    }
    const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (normalizedValue.length % 4 || 0)) % 4;
    const padded = normalizedValue.padEnd(normalizedValue.length + padding, '=');

    if (globalObj.Buffer) {
      try {
        return globalObj.Buffer.from(padded, 'base64').toString('utf8');
      } catch {
        // Ignore decoding errors.
      }
    }

    if (typeof globalObj.atob === 'function') {
      try {
        const binary = globalObj.atob(padded);
        let result = '';
        for (let i = 0; i < binary.length; i += 1) {
          result += String.fromCharCode(binary.charCodeAt(i));
        }
        return result;
      } catch {
        // Ignore decoding errors.
      }
    }

    return null;
  };

  const tryParseUrl = (value: string | null | undefined): URL | null => {
    if (!value) {
      return null;
    }
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };

  const resolveRedirectTarget = (urlObj: URL): URL | null => {
    const hostname = urlObj.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    if (hostname === 'news.google.com') {
      const paramTarget = tryParseUrl(urlObj.searchParams.get('url') || urlObj.searchParams.get('u'));
      if (paramTarget) {
        return paramTarget;
      }

      const segments = urlObj.pathname.split('/');
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (!segment) {
          continue;
        }
        const decoded = decodeBase64(segment);
        if (!decoded) {
          continue;
        }
        const match = decoded.match(/https?:\/\/[^\s"'<>]+/i);
        if (match) {
          const candidate = tryParseUrl(match[0]);
          if (candidate) {
            return candidate;
          }
        }
      }
    }

    if (hostname === 'www.google.com' && urlObj.pathname === '/url') {
      const paramTarget = tryParseUrl(urlObj.searchParams.get('url') || urlObj.searchParams.get('q'));
      if (paramTarget) {
        return paramTarget;
      }
    }

    return null;
  };

  addVariant(normalized);

  try {
    const initial = new URL(normalized);
    const seen = new Set<string>();
    const queue: URL[] = [];

    const enqueue = (candidate: URL) => {
      candidate.hash = '';
      const key = candidate.toString();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      queue.push(candidate);
    };

    enqueue(initial);

    while (queue.length) {
      const current = queue.pop()!;
      const currentString = current.toString();
      addVariant(currentString);
      addHostPathVariants(current);

      const redirectTarget = resolveRedirectTarget(current);
      if (redirectTarget) {
        enqueue(redirectTarget);
      }

      if (current.search) {
        const withoutQuery = new URL(currentString);
        withoutQuery.search = '';
        enqueue(withoutQuery);
      }

      const hostnames = new Set<string>();
      if (current.hostname) {
        hostnames.add(current.hostname);
        if (current.hostname.startsWith('www.')) {
          hostnames.add(current.hostname.slice(4));
        } else {
          hostnames.add(`www.${current.hostname}`);
        }
      }

      const protocols = new Set<string>();
      if (current.protocol) {
        protocols.add(current.protocol);
        if (current.protocol === 'https:') {
          protocols.add('http:');
        } else if (current.protocol === 'http:') {
          protocols.add('https:');
        }
      }

      for (const hostname of hostnames) {
        if (!hostname) {
          continue;
        }
        for (const protocol of protocols) {
          if (!protocol) {
            continue;
          }
          const variantUrl = new URL(currentString);
          variantUrl.hostname = hostname;
          variantUrl.protocol = protocol;
          enqueue(variantUrl);
        }
      }
    }
  } catch {
    // Ignore malformed URLs that cannot be parsed.
  }

  return Array.from(variants);
}

function cleanModelOutput(raw: string | null | undefined): string {
  return (raw || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function findMissingSources(content: string, sources: string[]): string[] {
  if (!sources.length) {
    return [];
  }

  const cited = new Set<string>();
  const anchorRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(content)) !== null) {
    const href = match[1];
    for (const variant of buildUrlVariants(href)) {
      if (variant) {
        cited.add(variant);
      }
    }
  }

  const missing: string[] = [];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    let found = false;
    for (const variant of buildUrlVariants(source)) {
      if (variant && cited.has(variant)) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push(source);
    }
  }

  return missing;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface SourceContext {
  url: string;
  title?: string;
  summary?: string;
}

interface KeywordEntry {
  value: string;
  isExact: boolean;
}

const FALLBACK_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'nor',
  'for',
  'so',
  'yet',
  'the',
  'of',
  'in',
  'on',
  'to',
  'with',
  'by',
  'as',
  'at',
  'from',
  'into',
  'about',
  'after',
  'before',
  'during',
  'while',
  'since',
  'until',
  'amid',
  'among',
  'between',
  'across',
  'around',
  'because',
  'that',
  'this',
  'those',
  'these',
  'their',
  'his',
  'her',
  'its',
  'our',
  'your',
  'my',
  'mine',
  'ours',
  'yours',
  'them',
  'they',
  'are',
  'is',
  'was',
  'were',
  'be',
  'being',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'not',
  'no',
  'it',
  'he',
  'she',
  'we',
  'you',
  'i',
  'me',
  'him',
  'her',
  'than',
  'then',
  'over',
  'under',
  'per',
  'via',
  'through',
  'toward',
  'towards',
]);

// Generate article content and ensure a minimum number of links are present
// prompt   - text prompt to send to the model
// model    - model name to use
// sources  - list of source URLs that may be linked
// minLinks - minimum number of <a href> links required in the output
async function generateWithLinks(
  prompt: string,
  model: string,
  sources: string[],
  systemPrompt?: string,
  minLinks: number = MIN_LINKS,
  maxTokens = 2000,
  minWords = 0,
  contextualSources: SourceContext[] = [],
  strictLinking = true
): Promise<string> {
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  const requiredCount = Math.min(Math.max(MIN_LINKS, sources.length), 5);
  const requiredSources = sources.slice(0, requiredCount);
  const trimmedPrompt = prompt.trim();
  let augmentedPrompt = trimmedPrompt;
  if (requiredSources.length > 0) {
    const reminderList = requiredSources
      .map((source, index) => `${index + 1}. ${source}`)
      .join('\n');
    const totalLinksNeeded = Math.max(minLinks, requiredSources.length);
    augmentedPrompt = `${trimmedPrompt}\n\nCite every required source inside natural sentences exactly once. Include at least ${totalLinksNeeded} total hyperlinks and do not fabricate extra citations.\nRequired sources (one citation per URL):\n${reminderList}`;
  }

  const promptLengthTokens = Math.ceil(augmentedPrompt.length / 4);
  const expectedFromWords = minWords > 0 ? Math.ceil(minWords * 1.6) : 0;
  const baseBudget = Math.max(maxTokens, expectedFromWords, promptLengthTokens * 2, 800);
  let tokens = Math.min(baseBudget, limit);
  const buildMessages = (content: string) =>
    systemPrompt
      ? [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content },
        ]
      : [{ role: 'user' as const, content }];

  let baseRes = await openai.chat.completions.create({
    model,
    messages: buildMessages(augmentedPrompt),
    temperature: FACTUAL_TEMPERATURE,
    max_tokens: tokens,
  });

  // If the response was cut off due to max_tokens, retry once with more room
  if (baseRes.choices[0]?.finish_reason === 'length' && tokens < limit) {
    tokens = limit;
    baseRes = await openai.chat.completions.create({
      model,
      messages: buildMessages(augmentedPrompt),
      temperature: FACTUAL_TEMPERATURE,
      max_tokens: tokens,
    });
  }

  let content = cleanModelOutput(baseRes.choices[0]?.message?.content);

  let linkCount = content.match(/<a\s+href=/gi)?.length || 0;

  if (requiredSources.length > 0) {
    let missingSources = new Set(findMissingSources(content, requiredSources));
    const MAX_LINKS = 5;

    if (missingSources.size > 0) {
      const containerRegex = /<(p|li)(\b[^>]*)>([\s\S]*?)<\/\1>/gi;
      const containers: {
        start: number;
        end: number;
        tag: string;
        attrs: string;
        inner: string;
      }[] = [];

      let match: RegExpExecArray | null;
      while ((match = containerRegex.exec(content)) !== null) {
        containers.push({
          start: match.index,
          end: match.index + match[0].length,
          tag: match[1],
          attrs: match[2] ?? '',
          inner: match[3] ?? '',
        });
      }

      if (containers.length === 0) {
        containers.push({
          start: 0,
          end: content.length,
          tag: '',
          attrs: '',
          inner: content,
        });
      }

      const contextByUrl = new Map<string, SourceContext>();
      for (const item of contextualSources) {
        if (!item?.url || contextByUrl.has(item.url)) {
          continue;
        }
        contextByUrl.set(item.url, item);
      }

      const keywordCache = new Map<string, KeywordEntry[]>();
      const wordCharRegex = /[\p{L}\p{N}'’\-]/u;

      const deriveKeywordsFor = (url: string): KeywordEntry[] => {
        if (keywordCache.has(url)) {
          return keywordCache.get(url)!;
        }
        const context = contextByUrl.get(url);
        const exactKeywords: KeywordEntry[] = [];
        const fuzzyKeywords: KeywordEntry[] = [];
        const seen = new Map<string, boolean>();

        const addKeyword = (value: string, isExact: boolean) => {
          const trimmed = value.replace(/\s+/g, ' ').trim();
          if (!trimmed || trimmed.length > 120) {
            return;
          }
          const normalized = trimmed.toLowerCase();
          const existing = seen.get(normalized);
          if (existing === true) {
            return;
          }
          if (existing === false) {
            if (!isExact) {
              return;
            }
            const index = fuzzyKeywords.findIndex(
              (entry) => entry.value.toLowerCase() === normalized
            );
            if (index !== -1) {
              fuzzyKeywords.splice(index, 1);
            }
          }

          seen.set(normalized, isExact);
          const bucket = isExact ? exactKeywords : fuzzyKeywords;
          bucket.push({ value: trimmed, isExact });
        };

        const rawTitle = context?.title?.replace(/\s+/g, ' ').trim();
        if (rawTitle) {
          addKeyword(rawTitle, true);
          const normalized = normalizeTitleValue(rawTitle);
          if (normalized) {
            const words = normalized.split(' ').filter((word) => word);
            for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
              for (let i = 0; i <= words.length - size; i += 1) {
                const slice = words.slice(i, i + size);
                if (slice.every((word) => FALLBACK_STOPWORDS.has(word))) {
                  continue;
                }
                if (slice.some((word) => word.length > 3)) {
                  addKeyword(slice.join(' '), false);
                }
              }
            }
            const filtered = words.filter((word) => !FALLBACK_STOPWORDS.has(word));
            for (const word of filtered) {
              if (word.length > 2) {
                addKeyword(word, false);
              }
            }
          }

          const delimiterParts = rawTitle
            .split(/[–—|:]+/)
            .map((part) => part.trim())
            .filter(Boolean);
          for (const part of delimiterParts) {
            if (/[A-Za-z0-9]/.test(part)) {
              addKeyword(part, true);
            }
          }

          const capitalizedMatches = rawTitle.match(
            /\b([A-Z][A-Za-z0-9&'’\-]*(?:\s+[A-Z][A-Za-z0-9&'’\-]*)*)\b/g
          );
          if (capitalizedMatches) {
            for (const phrase of capitalizedMatches) {
              addKeyword(phrase, true);
            }
          }
        }

        const summary = context?.summary?.replace(/\s+/g, ' ').trim();
        if (summary) {
          const capitalizedMatches = summary.match(
            /\b([A-Z][A-Za-z0-9&'’\-]*(?:\s+[A-Z][A-Za-z0-9&'’\-]*)*)\b/g
          );
          if (capitalizedMatches) {
            for (const phrase of capitalizedMatches.slice(0, 6)) {
              addKeyword(phrase, true);
            }
          }
        }

        try {
          const host = new URL(url).hostname.replace(/^www\./i, '');
          if (host) {
            addKeyword(host, false);
            const parts = host.split('.');
            if (parts.length > 1) {
              addKeyword(parts.slice(0, -1).join(' '), false);
            }
            const primary = parts[0];
            if (primary) {
              addKeyword(primary.replace(/[-_]+/g, ' '), false);
            }
          }
        } catch {
          // Ignore invalid URLs
        }

        const combined = [...exactKeywords, ...fuzzyKeywords];
        keywordCache.set(url, combined);
        return combined;
      };

      const collectSegments = (html: string) => {
        const segments: { text: string; start: number; end: number }[] = [];
        let index = 0;
        let anchorDepth = 0;
        while (index < html.length) {
          if (html[index] === '<') {
            const closeIndex = html.indexOf('>', index + 1);
            if (closeIndex === -1) {
              break;
            }
            const rawTag = html.slice(index + 1, closeIndex).trim();
            const isClosing = rawTag.startsWith('/');
            const tagName = rawTag
              .replace(/^\//, '')
              .replace(/\s+[\s\S]*$/, '')
              .toLowerCase();
            if (!isClosing && tagName === 'a') {
              anchorDepth += 1;
            } else if (isClosing && tagName === 'a' && anchorDepth > 0) {
              anchorDepth -= 1;
            }
            index = closeIndex + 1;
            continue;
          }
          const start = index;
          while (index < html.length && html[index] !== '<') {
            index += 1;
          }
          if (anchorDepth === 0 && start < index) {
            segments.push({ text: html.slice(start, index), start, end: index });
          }
        }
        return segments;
      };

      const findKeywordMatch = (html: string, keywords: KeywordEntry[]) => {
        const segments = collectSegments(html);
        if (!segments.length) {
          return null;
        }
        const prioritized = [
          ...keywords.filter((entry) => entry.isExact),
          ...keywords.filter((entry) => !entry.isExact),
        ];
        for (const keyword of prioritized) {
          const target = keyword.value.trim();
          if (!target) {
            continue;
          }
          const searchTarget = keyword.isExact ? target : target.toLowerCase();
          for (const segment of segments) {
            const haystack = keyword.isExact
              ? segment.text
              : segment.text.toLowerCase();
            let searchIndex = 0;
            while (searchIndex <= haystack.length) {
              const foundIndex = haystack.indexOf(searchTarget, searchIndex);
              if (foundIndex === -1) {
                break;
              }
              const beforeChar = segment.text[foundIndex - 1];
              const afterChar = segment.text[foundIndex + target.length];
              const hasBefore = beforeChar ? wordCharRegex.test(beforeChar) : false;
              const hasAfter = afterChar ? wordCharRegex.test(afterChar) : false;
              if (!hasBefore && !hasAfter) {
                return {
                  start: segment.start + foundIndex,
                  end: segment.start + foundIndex + target.length,
                };
              }
              searchIndex = foundIndex + 1;
            }
          }
        }
        return null;
      };

      const findFallbackMatch = (html: string) => {
        const segments = collectSegments(html);
        let firstTextRange: { start: number; end: number } | null = null;
        for (const segment of segments) {
          const regex = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(segment.text)) !== null) {
            const word = match[0];
            if (word.length < 3) {
              continue;
            }
            if (FALLBACK_STOPWORDS.has(word.toLowerCase())) {
              continue;
            }
            return {
              start: segment.start + match.index,
              end: segment.start + match.index + word.length,
            };
          }
          if (!firstTextRange) {
            const trimmed = segment.text.replace(/^\s+/, '');
            if (trimmed) {
              const leadingWhitespaceLength = segment.text.length - trimmed.length;
              firstTextRange = {
                start: segment.start + leadingWhitespaceLength,
                end: segment.start + leadingWhitespaceLength + trimmed.length,
              };
            }
          }
        }
        return firstTextRange;
      };

      const wrapRange = (html: string, range: { start: number; end: number }, safeUrl: string) => {
        const anchorStart = `<a href="${safeUrl}" target="_blank" rel="noopener">`;
        const anchorEnd = '</a>';
        return (
          html.slice(0, range.start) +
          anchorStart +
          html.slice(range.start, range.end) +
          anchorEnd +
          html.slice(range.end)
        );
      };

      const missingQueue = requiredSources.filter((source) => missingSources.has(source));
      let containerIndex = 0;
      let modified = false;

      for (const source of missingQueue) {
        if (!missingSources.has(source) || linkCount >= MAX_LINKS) {
          continue;
        }
        const safeUrl = escapeHtml(source);
        const keywords = deriveKeywordsFor(source);
        const containerCount = containers.length;
        let inserted = false;

        for (let offset = 0; offset < containerCount; offset += 1) {
          const container = containers[(containerIndex + offset) % containerCount];
          const matchRange = findKeywordMatch(container.inner, keywords);
          if (matchRange) {
            container.inner = wrapRange(container.inner, matchRange, safeUrl);
            missingSources.delete(source);
            linkCount += 1;
            containerIndex = (containerIndex + offset + 1) % containerCount;
            inserted = true;
            modified = true;
            break;
          }
        }

        if (!inserted) {
          for (let offset = 0; offset < containers.length; offset += 1) {
            const container = containers[(containerIndex + offset) % containers.length];
            const fallbackRange = findFallbackMatch(container.inner);
            if (fallbackRange) {
              container.inner = wrapRange(container.inner, fallbackRange, safeUrl);
              missingSources.delete(source);
              linkCount += 1;
              containerIndex = (containerIndex + offset + 1) % containers.length;
              inserted = true;
              modified = true;
              break;
            }
          }
        }

        if (linkCount >= MAX_LINKS) {
          break;
        }
      }

      if (modified) {
        let rebuilt = '';
        let lastIndex = 0;
        for (const container of containers) {
          rebuilt += content.slice(lastIndex, container.start);
          if (container.tag) {
            rebuilt += `<${container.tag}${container.attrs}>${container.inner}</${container.tag}>`;
          } else {
            rebuilt += container.inner;
          }
          lastIndex = container.end;
        }
        rebuilt += content.slice(lastIndex);
        content = rebuilt;
      }
    }

    if (
      strictLinking &&
      missingSources.size > STRICT_LINK_RETRY_THRESHOLD &&
      requiredSources.length > 0
    ) {
      const contextByUrl = new Map<string, SourceContext>();
      for (const item of contextualSources) {
        if (!item?.url || contextByUrl.has(item.url)) {
          continue;
        }
        contextByUrl.set(item.url, item);
      }

      const missingList = requiredSources.filter((source) =>
        missingSources.has(source)
      );
      if (missingList.length > 0) {
        const summaryList = missingList
          .map((url, index) => {
            const context = contextByUrl.get(url);
            const parts = [`${index + 1}. ${url}`];
            if (context?.title) {
              parts.push(`Title: ${context.title}`);
            }
            if (context?.summary) {
              parts.push(`Summary: ${context.summary}`);
            }
            return parts.join('\n');
          })
          .join('\n\n');

        const paragraphLabel =
          missingList.length === 1 ? 'paragraph' : 'paragraphs';
        const repairLines = [
          `Write ${missingList.length} concise HTML ${paragraphLabel} that can be appended to an article.`,
          'Each paragraph must naturally cite the matching source exactly once using descriptive anchor text and must not include any other links.',
          'Keep each paragraph to two sentences or fewer.',
        ];
        if (summaryList) {
          repairLines.push('', summaryList);
        }
        const repairPrompt = repairLines.join('\n');

        let repairTokens = Math.min(
          Math.max(400, Math.ceil(missingList.length * 220)),
          limit
        );
        let retryRes = await openai.chat.completions.create({
          model,
          messages: buildMessages(repairPrompt),
          temperature: FACTUAL_TEMPERATURE,
          max_tokens: repairTokens,
        });

        if (
          retryRes.choices[0]?.finish_reason === 'length' &&
          repairTokens < limit
        ) {
          repairTokens = limit;
          retryRes = await openai.chat.completions.create({
            model,
            messages: buildMessages(repairPrompt),
            temperature: FACTUAL_TEMPERATURE,
            max_tokens: repairTokens,
          });
        }

        const repairContent = cleanModelOutput(
          retryRes.choices[0]?.message?.content
        );
        if (repairContent) {
          const trimmed = repairContent.trim();
          const joiner = trimmed.startsWith('<') ? '' : '\n';
          content = `${content}${joiner}${trimmed}`;
        }
        linkCount = content.match(/<a\s+href=/gi)?.length || 0;
        missingSources = new Set(findMissingSources(content, requiredSources));
      }
    }
  }

  return content;
}

interface VerificationResult {
  isAccurate: boolean;
  discrepancies: string[];
}

function truncateField(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= VERIFICATION_MAX_SOURCE_FIELD_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, VERIFICATION_MAX_SOURCE_FIELD_LENGTH - 1)}…`;
}

function normalizeVerificationSources(
  sources: VerificationSource[]
): Array<{ url: string; title?: string; summary?: string; publishedAt?: string }> {
  const seen = new Set<string>();
  const normalized: Array<{
    url: string;
    title?: string;
    summary?: string;
    publishedAt?: string;
  }> = [];

  for (const source of sources) {
    if (normalized.length >= VERIFICATION_MAX_SOURCES) {
      break;
    }

    let url: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let publishedAt: string | undefined;

    if (typeof source === 'string') {
      url = source;
    } else if (source) {
      url = source.url ?? undefined;
      title = source.title ?? undefined;
      summary = source.summary ?? undefined;
      publishedAt = source.publishedAt ?? undefined;
    }

    const trimmedUrl = url?.trim();
    if (!trimmedUrl) {
      continue;
    }

    const normalizedUrl = trimmedUrl.replace(/\s+/g, ' ');
    if (seen.has(normalizedUrl)) {
      continue;
    }

    seen.add(normalizedUrl);
    normalized.push({
      url: normalizedUrl,
      title,
      summary,
      publishedAt,
    });
  }

  return normalized;
}

async function verifyOutput(
  content: string,
  sources: VerificationSource[]
): Promise<VerificationResult> {
  const trimmedContent = content?.trim();
  if (!trimmedContent) {
    return { isAccurate: true, discrepancies: [] };
  }

  const normalizedSources = normalizeVerificationSources(sources);
  if (!process.env.GROK_API_KEY || normalizedSources.length === 0) {
    return { isAccurate: true, discrepancies: [] };
  }

  const formattedSources = normalizedSources
    .map((item, index) => {
      const parts = [`${index + 1}. URL: ${item.url}`];
      const title = truncateField(item.title);
      const summary = truncateField(item.summary);
      const publishedAt = truncateField(item.publishedAt);
      if (title) {
        parts.push(`   Title: ${title}`);
      }
      if (summary) {
        parts.push(`   Summary: ${summary}`);
      }
      if (publishedAt) {
        parts.push(`   Published: ${publishedAt}`);
      }
      return parts.join('\n');
    })
    .join('\n');

  const prompt = [
    'Check if this article matches sources; list discrepancies.',
    '',
    'You are a post-generation fact-checking assistant. Compare the article HTML to the provided sources and highlight any unsupported or contradictory claims.',
    'Respond with JSON using this schema: {"discrepancies":[{"description":string,"severity":"minor"|"major"}]}.',
    'Classify issues as "major" when the article conflicts with, misstates, or omits critical facts from the sources.',
    '',
    'Article HTML:',
    trimmedContent,
    '',
    'Sources:',
    formattedSources || 'No sources provided.',
  ].join('\n');

  try {
    const response = await grokChatCompletion({
      prompt,
      temperature: 0,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
    });
    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }

    if (!parsed || !Array.isArray(parsed.discrepancies)) {
      return { isAccurate: true, discrepancies: [] };
    }

    const normalizedDiscrepancies = parsed.discrepancies
      .map((item: any) => {
        if (!item) {
          return null;
        }
        if (typeof item === 'string') {
          return { description: item.trim(), severity: 'major' };
        }
        if (typeof item === 'object') {
          const description = typeof item.description === 'string' ? item.description.trim() : '';
          if (!description) {
            return null;
          }
          const severity = typeof item.severity === 'string' ? item.severity.toLowerCase() : 'major';
          return { description, severity };
        }
        return null;
      })
      .filter((item: { description: string; severity: string } | null): item is {
        description: string;
        severity: string;
      } => Boolean(item && item.description));

    const majorIssues = normalizedDiscrepancies.filter(
      (item) => (item.severity || 'major').toLowerCase() !== 'minor'
    );

    if (majorIssues.length > VERIFICATION_DISCREPANCY_THRESHOLD) {
      const summaries = majorIssues.map(
        (item) => `[${(item.severity || 'major').toUpperCase()}] ${item.description}`
      );
      console.warn('Accuracy issues: ', summaries);
      return { isAccurate: false, discrepancies: summaries };
    }

    return { isAccurate: true, discrepancies: [] };
  } catch (err) {
    console.warn('[api/generate] verification failed', err);
    return { isAccurate: true, discrepancies: [] };
  }
}

function applyVerificationIssuesToPrompt(basePrompt: string, issues?: string[]): string {
  if (!issues || issues.length === 0) {
    return basePrompt;
  }

  const formattedIssues = issues
    .map((issue, index) => `${index + 1}. ${issue.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  return `${basePrompt}\n\nThe previous draft was flagged for factual inaccuracies:\n${formattedIssues}\nRevise the article to resolve every issue without introducing new errors. Only output the corrected HTML article.`;
}

async function generateWithVerification(
  generator: (issues?: string[]) => Promise<string>,
  sources: VerificationSource[],
  fallbackSources: string[] = []
): Promise<string> {
  const combinedSources = sources.length
    ? sources
    : fallbackSources.map((url) => ({ url }));
  const shouldVerify = Boolean(process.env.GROK_API_KEY) && combinedSources.length > 0;

  const initialContent = await generator();
  if (!shouldVerify) {
    return initialContent;
  }

  const verification = await verifyOutput(initialContent, combinedSources);
  if (verification.isAccurate) {
    return initialContent;
  }

  const issues = Array.isArray(verification.discrepancies)
    ? verification.discrepancies.filter((item) => typeof item === 'string' && item.trim())
    : [];

  if (!issues.length) {
    return initialContent;
  }

  console.warn('Revising article once to resolve accuracy issues', issues);

  try {
    return await generator(issues);
  } catch (err) {
    console.warn('Revision attempt failed, returning initial article', err);
    return initialContent;
  }
}

export async function POST(request: Request) {
  try {
    const {
      articleType,
      title,
      listNumberingFormat,
      listItemWordCount = 100,
      videoLink,
      blogLink,
      toneOfVoice,
      customTone,
      pointOfView,
      customInstructions,
      lengthOption,
      customSections,
      modelVersion = 'gpt-4o-mini',
      useSerpApi = true,
      includeLinks = true,
      useSummary = false,
      newsFreshness,
    }: {
      articleType: string;
      title: string;
      listNumberingFormat?: string;
      listItemWordCount?: number;
      videoLink?: string;
      blogLink?: string;
      toneOfVoice?: string;
      customTone?: string;
      pointOfView?: string;
      customInstructions?: string;
      lengthOption?: string;
      customSections?: number;
      modelVersion?: string;
      useSerpApi?: boolean;
      includeLinks?: boolean;
      useSummary?: boolean;
      newsFreshness?: NewsFreshness;
    } = await request.json();

    if (!title?.trim()) {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 });
    }

    const serpEnabled = includeLinks && useSerpApi && !!process.env.SERPAPI_KEY;
    const baseMaxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);
    const nowIso = new Date().toISOString();
    const systemPrompt = `The current date and time is ${nowIso}. Treat the reporting summaries and source links supplied in prompts as authoritative context. Avoid introducing unsourced details or time-sensitive claims that are not confirmed by those references. If sources conflict, highlight both sides (e.g., "Source A reports X, while Source B claims Y"). When mentioning Donald Trump, understand that he is the current president of the United States.`;
    const toneChoice =
      toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
    const toneInstruction = toneChoice
      ? `- Write in a ${toneChoice} tone of voice.\n`
      : '';
    const povInstruction = pointOfView
      ? `- Use a ${pointOfView} perspective.\n`
      : '';

    if (articleType === 'News article') {
      const articles = await fetchNewsArticles(title, newsFreshness, serpEnabled);
      if (!articles.length) {
        return NextResponse.json(
          { error: 'No recent news articles found for that topic.' },
          { status: 502 }
        );
      }

      const newsSources = Array.from(
        new Set(articles.map((item) => item.url).filter(Boolean))
      );
      const linkSources = includeLinks ? newsSources : [];
      const requiredLinks = includeLinks
        ? linkSources.slice(
            0,
            Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
          )
        : [];
      const minLinks = includeLinks ? requiredLinks.length : 0;
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction =
        includeLinks && requiredLinks.length
          ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
              .map((u) => `  - ${u}`)
              .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
          : '';

      const reportingBlock = buildRecentReportingBlock(articles);

      let lengthInstruction = '';
      if (lengthOption === 'custom' && customSections) {
        const approx = customSections * 220;
        lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
      } else if (lengthOption && WORD_RANGES[lengthOption]) {
        const [minW, maxW] = WORD_RANGES[lengthOption];
        lengthInstruction = `- Keep the article between ${minW} and ${maxW} words.\n`;
      } else {
        lengthInstruction = '- Aim for a concise, timely report (~900 words).\n';
      }

      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';

      const articlePrompt = `
You are a professional news reporter writing a fast-turnaround article about "${title}".

Do NOT include the title or any <h1> tag in the HTML output.

${reportingBlock}

${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${customInstructionBlock}  - Synthesize the developments from the listed sources into a cohesive news article.
  - Attribute key facts to the appropriate source by linking the relevant URL directly in the text.
  - Clearly indicate the timing of significant events and why they matter now.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}  - Do NOT invent sources or information not present in the listed reporting.

Write the full article in valid HTML below:
`.trim();

      const buildArticlePrompt = (issues?: string[]) =>
        applyVerificationIssuesToPrompt(articlePrompt, issues);

      const [minBound] = getWordBounds(lengthOption, customSections);
      const minWords =
        !lengthOption || lengthOption === 'default'
          ? Math.min(minBound, 900)
          : minBound;
      const maxTokens = Math.min(baseMaxTokens, 4000);

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            buildArticlePrompt(issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            maxTokens,
            minWords,
            articles
          ),
        articles,
        newsSources
      );

      return NextResponse.json({
        content,
        sources: newsSources,
      });
    }

    const reportingContextPromise: Promise<ReportingContext> = (async () => {
      if (!serpEnabled) {
        return {
          reportingSources: [],
          reportingBlock: '',
          groundingInstruction: '',
          linkSources: [],
          referenceBlock: '',
        };
      }

      const reportingSources = await fetchSources(title, newsFreshness);
      const reportingBlock = buildRecentReportingBlock(reportingSources);
      const groundingInstruction = reportingSources.length
        ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\n'
        : '';
      const linkSources = reportingSources
        .map((item) => item.url)
        .filter(Boolean);
      const referenceBlock =
        linkSources.length > 0
          ? `• Use these references:\n${linkSources
              .map((u) => `- ${u}`)
              .join('\n')}`
          : '';

      return {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
        referenceBlock,
      };
    })();

    // ─── Listicle/Gallery ────────────────────────────────────────────────────────
    if (articleType === 'Listicle/Gallery') {
      const {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
        referenceBlock,
      } = await reportingContextPromise;
      const match = title.match(/\d+/);
      const count = match ? parseInt(match[0], 10) : 5;

      const reportingContext = reportingBlock ? `${reportingBlock}\n\n` : '';
      const outlinePrompt = `
You are a professional writer tasked with planning a factual, source-grounded listicle outline.

Title: "${title}"

${reportingContext}Requirements:
• Use exactly ${count} items.
• Number each heading formatted like ${listNumberingFormat}.
• Provide a short clause after each numbered heading describing the key sourced insight it should cover.
• Keep the outline tightly focused on the developments described in the reporting summaries.
• Preserve every concrete fact from the reporting block—names, dates, figures, locations, direct quotes—and restate them verbatim inside the relevant numbered heading or bullet instead of paraphrasing generically.
• For every bullet that uses a reporting summary, append " (Source: URL)" with the matching link.
• Do not merge distinct facts into one bullet: break out each specific person, organization, date, or metric so it can be cited individually.
${referenceBlock ? `${referenceBlock}\n` : ''}• Do not invent new facts beyond the provided sources.
`.trim();

      const outline = await generateOutlineWithGrokFallback(
        outlinePrompt,
        modelVersion,
        0.6
      );

      const lengthInstruction = `- Use exactly ${count} items.\n`;
      const numberingInstruction = listNumberingFormat
        ? `- Use numbering formatted like ${listNumberingFormat}.\n`
        : '';
      const wordCountInstruction =
        listItemWordCount
          ? `- Keep each list item around ${listItemWordCount} words.\n`
          : '';
      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const requiredLinks = linkSources.slice(
        0,
        Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
      );
      const minLinks = requiredLinks.length; // how many links to require
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction = requiredLinks.length
        ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
        : '';
      const toneChoice =
        toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
      const toneInstruction = toneChoice
        ? `- Write in a ${toneChoice} tone of voice.\n`
        : '';
      const povInstruction = pointOfView
        ? `- Use a ${pointOfView} perspective.\n`
        : '';

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = `
You are a professional journalist writing a listicle-style web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${numberingInstruction}${wordCountInstruction}${customInstructionBlock}  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const wordsPerItem = listItemWordCount || 100;
      const desired = count * wordsPerItem + 50;
      let maxTokens = Math.ceil((desired * 1.2) / 0.75); // add 20% buffer
      const limit = MODEL_CONTEXT_LIMITS[modelVersion] || 8000;
      maxTokens = Math.min(maxTokens, limit);
      const minWords = Math.floor(count * wordsPerItem * 0.8);

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyVerificationIssuesToPrompt(articlePrompt, issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            maxTokens,
            minWords,
            reportingSources
          ),
        reportingSources,
        linkSources
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── YouTube Transcript → Blog ─────────────────────────────────────────────
    if (articleType === 'YouTube video to blog post') {
      const transcriptPromise = fetchTranscript(videoLink || '');
      const {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
      } = await reportingContextPromise;
      const transcript = await transcriptPromise;
      const transcriptInstruction = transcript
        ? `- Use the following transcript as source material:\n\n${transcript}\n\n`
        : `- Use the transcript from this video link as source material: ${videoLink}\n`;
      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const requiredLinks = linkSources.slice(
        0,
        Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
      );
      const minLinks = requiredLinks.length; // how many links to require
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction = requiredLinks.length
        ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
        : '';

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = `
You are a professional journalist writing a web article from a YouTube transcript.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

${transcriptInstruction}${reportingSection}${toneInstruction}${povInstruction}Requirements:
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const [minWords] = getWordBounds(lengthOption, customSections);

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyVerificationIssuesToPrompt(articlePrompt, issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            baseMaxTokens,
            minWords,
            reportingSources
          ),
        reportingSources,
        linkSources
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── Rewrite blog post ──────────────────────────────────────────────────────
    if (articleType === 'Rewrite blog post') {
      const maxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);
      const sourceTextPromise = summarizeBlogContent(
        blogLink || '',
        useSummary,
        modelVersion
      );
      const {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
      } = await reportingContextPromise;
      const sourceText = await sourceTextPromise;

      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const requiredLinks = linkSources.slice(
        0,
        Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
      );
      const minLinks = requiredLinks.length; // how many links to require
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction = requiredLinks.length
        ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
        : '';
      const rewriteInstruction = sourceText
        ? `- Rewrite the following content completely to avoid plagiarism:\n\n${sourceText}\n\n`
        : `- Rewrite the blog post at this URL completely to avoid plagiarism: ${blogLink}\n`;

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      let lengthInstruction: string;
      if (lengthOption === 'default') {
        lengthInstruction =
          `- Aim for around 9 sections (~${DEFAULT_WORDS.toLocaleString()} words total, ~220 words per section), but feel free to adjust based on the topic.\n`;
      } else if (lengthOption === 'custom' && customSections) {
        const approx = customSections * 220;
        lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
      } else if (WORD_RANGES[lengthOption || 'medium']) {
        const [minW, maxW] = WORD_RANGES[lengthOption || 'medium'];
        const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
        lengthInstruction =
          `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
      } else {
        lengthInstruction =
          '- Aim for around 9 sections (~1,900 words total, ~220 words per section), but feel free to adjust based on the topic.\n';
      }

      const articlePrompt = `
You are a professional journalist rewriting an existing blog post into a fresh, original article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

${rewriteInstruction}${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Begin with a 2–3 sentence introduction (no <h2> tags).
  - Organize the article with <h2> headings similar to the original structure.
  - Under each <h2>, write 2–3 paragraphs.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyVerificationIssuesToPrompt(articlePrompt, issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            maxTokens,
            getWordBounds(lengthOption, customSections)[0],
            reportingSources
          ),
        reportingSources,
        linkSources
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── Blog post (default) ───────────────────────────────────────────────────
    const {
      reportingSources,
      reportingBlock,
      groundingInstruction,
      linkSources,
      referenceBlock,
    } = await reportingContextPromise;

    let sectionInstruction: string;
    if (lengthOption === 'default') {
      sectionInstruction = 'Include around 9 <h2> headings.';
    } else if (lengthOption === 'custom' && customSections) {
      sectionInstruction = `Use exactly ${customSections} <h2> headings.`;
    } else if (sectionRanges[lengthOption || 'medium']) {
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      sectionInstruction =
        `Include ${minS}–${maxS} <h2> headings.`;
    } else {
      sectionInstruction = 'Include at least three <h2> headings.';
    }

    const reportingContext = reportingBlock ? `${reportingBlock}\n\n` : '';
    const baseOutline = `
You are a professional writer creating a factually accurate, well-structured outline for the article titled "${title}".

${reportingContext}Outline requirements:
• Begin with a section labeled "INTRO:" and include a single bullet with a 2–3 sentence introduction (no <h2>).
• The INTRO bullet must highlight the most newsworthy concrete facts—names, dates, figures, locations—from the reporting summaries and cite the matching sources instead of offering generic context.
• After the "INTRO:" section, ${sectionInstruction}.
• Under each <h2>, list 2–3 bullet-point subtopics describing what evidence, examples, or angles to cover.
• Preserve every concrete fact from the reporting block and Key details list—names, dates, figures, locations, quotes—and restate them verbatim within the relevant subtopic bullets rather than summarizing vaguely.
• For every bullet that draws on reporting, append " (Source: URL)" with the matching link.
• Do not combine multiple unrelated facts in a single bullet; give each person, organization, metric, or timestamp its own bullet so it can be cited precisely.
• Do NOT use "Introduction" or "Intro" as an <h2> heading.
• Do NOT use "Conclusion" or "Bottom line" as an <h2> heading.
${referenceBlock ? `${referenceBlock}\n` : ''}• Do not invent information beyond the provided reporting.
`.trim();

    const outline = await generateOutlineWithGrokFallback(
      baseOutline,
      modelVersion
    );

    const customInstruction = customInstructions?.trim();
    const customInstructionBlock = customInstruction
      ? `- ${customInstruction}\n`
      : '';
    let lengthInstruction: string;
    if (lengthOption === 'default') {
      lengthInstruction =
        `- Aim for around 9 sections (~${DEFAULT_WORDS.toLocaleString()} words total, ~220 words per section), ` +
        'but feel free to adjust based on the topic.\n';
    } else if (lengthOption === 'custom' && customSections) {
      const approx = customSections * 220;
      lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
    } else if (WORD_RANGES[lengthOption || 'medium']) {
      const [minW, maxW] = WORD_RANGES[lengthOption || 'medium'];
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      lengthInstruction =
        `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
    } else {
      lengthInstruction =
        '- Aim for around 9 sections (~1,900 words total, ~220 words per section), but feel free to adjust based on the topic.\n';
    }

    const requiredLinks = linkSources.slice(
      0,
      Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
    );
    const minLinks = requiredLinks.length; // how many links to require
    const optionalLinks = linkSources.slice(requiredLinks.length);
    const optionalInstruction = optionalLinks.length
      ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
          .map((u) => `    - ${u}`)
          .join('\n')}`
      : '';
    const linkInstruction = requiredLinks.length
      ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
          .map((u) => `  - ${u}`)
          .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
      : '';

    const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

    const articlePrompt = `
You are a professional journalist writing a web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}
  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Output raw HTML only:
`.trim();

    const content = await generateWithVerification(
      (issues) =>
        generateWithLinks(
          applyVerificationIssuesToPrompt(articlePrompt, issues),
          modelVersion,
          linkSources,
          systemPrompt,
          minLinks,
          baseMaxTokens,
          getWordBounds(lengthOption, customSections)[0],
          reportingSources
        ),
      reportingSources,
      linkSources
    );
    return NextResponse.json({
      content,
      sources: linkSources,
    });
  } catch (err: any) {
    console.error('[api/generate] error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal error' },
      { status: 500 }
    );
  }
}
