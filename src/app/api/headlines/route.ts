import { NextRequest, NextResponse } from 'next/server';
import {
  CATEGORY_FEED_SET,
  type CategoryFeedValue,
} from '../../../constants/categoryFeeds';
import { openai } from '../../../lib/openai';
import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 5;
const MAX_FILTER_LIST_ITEMS = 20;
const MAX_DESCRIPTION_QUERY_LENGTH = 500;

const LANGUAGE_CODES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'he',
  'it',
  'nl',
  'no',
  'pt',
  'ru',
  'sv',
  'ud',
  'zh',
] as const;
type LanguageCode = (typeof LANGUAGE_CODES)[number];
const LANGUAGE_SET = new Set<string>(LANGUAGE_CODES);

type CategoryValue = CategoryFeedValue;
const CATEGORY_SET = CATEGORY_FEED_SET;

const COUNTRY_CODES = [
  'ae',
  'ar',
  'at',
  'au',
  'be',
  'bg',
  'br',
  'ca',
  'ch',
  'cn',
  'co',
  'cu',
  'cz',
  'de',
  'eg',
  'fr',
  'gb',
  'gr',
  'hk',
  'hu',
  'id',
  'ie',
  'il',
  'in',
  'it',
  'jp',
  'kr',
  'lt',
  'lv',
  'ma',
  'mx',
  'my',
  'ng',
  'nl',
  'no',
  'nz',
  'ph',
  'pl',
  'pt',
  'ro',
  'rs',
  'ru',
  'sa',
  'se',
  'sg',
  'si',
  'sk',
  'th',
  'tr',
  'tw',
  'ua',
  'us',
  've',
  'za',
] as const;
type CountryCode = (typeof COUNTRY_CODES)[number];
const COUNTRY_SET = new Set<string>(COUNTRY_CODES);

const SORT_BY_VALUES = ['publishedAt', 'relevancy', 'popularity'] as const;
type SortBy = (typeof SORT_BY_VALUES)[number];
const SORT_BY_SET = new Set<string>(SORT_BY_VALUES);

const SEARCH_IN_VALUES = ['title', 'description', 'content'] as const;
type SearchInValue = (typeof SEARCH_IN_VALUES)[number];
const SEARCH_IN_SET = new Set<string>(SEARCH_IN_VALUES);

const ISO_DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const SOURCE_ID_REGEX = /^[a-z0-9._-]+$/;
const DOMAIN_ALLOWED_REGEX = /^[a-z0-9.-]+$/;

function resolveLimit(rawLimit: unknown): number {
  let numeric: number | null = null;

  if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
    numeric = rawLimit;
  } else if (typeof rawLimit === 'string' && rawLimit.trim()) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed)) {
      numeric = parsed;
    }
  }

  if (numeric === null) {
    return DEFAULT_LIMIT;
  }

  const truncated = Math.trunc(numeric);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, truncated));
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeLanguage(raw: unknown): LanguageCode | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new Error('language must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'all' || lowered === 'any') {
    return null;
  }

  if (!LANGUAGE_SET.has(lowered)) {
    throw new Error(`Unsupported language filter: ${trimmed}`);
  }

  return lowered as LanguageCode;
}

function normalizeSortBy(raw: unknown): SortBy {
  if (raw === undefined || raw === null) {
    return 'publishedAt';
  }

  if (typeof raw !== 'string') {
    throw new Error('sortBy must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return 'publishedAt';
  }

  if (!SORT_BY_SET.has(trimmed)) {
    throw new Error(`Unsupported sortBy value: ${trimmed}`);
  }

  return trimmed as SortBy;
}

function normalizeDate(raw: unknown, field: 'from' | 'to'): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error(`${field} must be an ISO8601 string`);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let isoValue: string;

  if (ISO_DATE_ONLY_REGEX.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${field} must be a valid ISO8601 date`);
    }
    isoValue = parsed.toISOString();
  } else if (ISO_DATE_TIME_REGEX.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${field} must be a valid ISO8601 date`);
    }
    isoValue = parsed.toISOString();
  } else {
    throw new Error(`${field} must be a valid ISO8601 date`);
  }

  return isoValue;
}

function normalizeCategory(raw: unknown): CategoryValue | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error('category must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  const candidate = lowered as CategoryValue;

  if (!CATEGORY_SET.has(candidate)) {
    throw new Error(`Unsupported category selection: ${trimmed}`);
  }

  return candidate;
}

function normalizeCountry(raw: unknown): CountryCode | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error('country must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (!COUNTRY_SET.has(lowered)) {
    throw new Error(`Unsupported country selection: ${trimmed}`);
  }

  return lowered as CountryCode;
}

function normalizeSearchIn(raw: unknown): SearchInValue[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',')
    : (() => {
        throw new Error('searchIn must be provided as a string or array');
      })();

  const selection = new Set<SearchInValue>();

  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('searchIn must contain strings only');
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (!SEARCH_IN_SET.has(lowered)) {
      throw new Error(`Unsupported searchIn value: ${trimmed}`);
    }
    selection.add(lowered as SearchInValue);
  }

  return SEARCH_IN_VALUES.filter((option) => selection.has(option));
}

function normalizeDelimitedList(
  raw: unknown,
  {
    field,
    lowercase = false,
    validator,
  }: {
    field: string;
    lowercase?: boolean;
    validator?: (value: string) => boolean;
  }
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',')
    : (() => {
        throw new Error(`${field} must be provided as a string or array`);
      })();

  const normalized: string[] = [];

  for (const entry of values) {
    if (typeof entry !== 'string') {
      throw new Error(`${field} must contain strings only`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const formatted = lowercase ? trimmed.toLowerCase() : trimmed;
    if (validator && !validator(formatted)) {
      throw new Error(`Invalid value in ${field}: ${trimmed}`);
    }
    normalized.push(formatted);
  }

  return Array.from(new Set(normalized)).slice(0, MAX_FILTER_LIST_ITEMS);
}

function normalizeSources(raw: unknown): string[] {
  return normalizeDelimitedList(raw, {
    field: 'sources',
    lowercase: true,
    validator: (value) => SOURCE_ID_REGEX.test(value),
  });
}

function normalizeDomains(
  raw: unknown,
  field: 'domains' | 'excludeDomains'
): string[] {
  return normalizeDelimitedList(raw, {
    field,
    lowercase: true,
    validator: (value) => DOMAIN_ALLOWED_REGEX.test(value) && value.includes('.'),
  });
}

type HeadlinesRequestBody = {
  query?: unknown;
  keywords?: unknown;
  description?: unknown;
  limit?: unknown;
  language?: unknown;
  sortBy?: unknown;
  from?: unknown;
  to?: unknown;
  searchIn?: unknown;
  sources?: unknown;
  domains?: unknown;
  excludeDomains?: unknown;
  category?: unknown;
  country?: unknown;
};

type OpenAIClient = {
  chat: {
    completions: {
      create: (
        options: {
          model: string;
          messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
          temperature?: number;
          max_tokens?: number;
        }
      ) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          } | null;
        }>;
      }>;
    };
  };
};

type HeadlinesHandlerDependencies = {
  fetchImpl?: typeof fetch;
  openaiClient?: OpenAIClient;
  logger?: Pick<typeof console, 'error'>;
};

function normalizeKeywords(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error('keywords must be provided as an array of strings');
  }

  const selection = new Set<string>();
  const normalized: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error('keywords must be provided as an array of strings');
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (selection.has(lowered)) {
      continue;
    }
    selection.add(lowered);
    normalized.push(trimmed);
    if (normalized.length >= MAX_FILTER_LIST_ITEMS) {
      break;
    }
  }

  return normalized;
}

function parseGeneratedQueries(raw: string): string[] {
  if (!raw) {
    return [];
  }

  const attemptParse = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean);
      }
    } catch {
      // ignore parse failure
    }
    return [];
  };

  const direct = attemptParse(raw);
  if (direct.length > 0) {
    return direct;
  }

  const bracketMatch = raw.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    const nested = attemptParse(bracketMatch[0]);
    if (nested.length > 0) {
      return nested;
    }
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*-•]+/, '').trim())
    .filter(Boolean);
}

function normalizeStringList(
  values: unknown,
  {
    limit = MAX_FILTER_LIST_ITEMS,
    lowercaseDedup = true,
  }: { limit?: number; lowercaseDedup?: boolean } = {}
): string[] {
  const entries: unknown[] = Array.isArray(values)
    ? values
    : typeof values === 'string'
    ? values.split(/[\r\n,;]+/)
    : [];

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.replace(/^[\s*-•]+/, '').trim();
    if (!trimmed) {
      continue;
    }

    const key = lowercaseDedup ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(trimmed);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

function extractSectionList(text: string, labels: string[]): string[] {
  for (const label of labels) {
    const regex = new RegExp(
      `${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\s*:\\s*([\\s\\S]*?)(?:\\n\\s*\\n|$)`,
      'i'
    );
    const match = text.match(regex);
    if (match) {
      return normalizeStringList(match[1]);
    }
  }

  return [];
}

function parseKeywordCategoryResponse(raw: string): {
  keywords: string[];
  categories: string[];
} {
  if (!raw) {
    return { keywords: [], categories: [] };
  }

  const attemptParse = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse failure
    }

    return null;
  };

  const keywordKeys = ['keywords', 'keywordSuggestions', 'topics', 'queries'];
  const categoryKeys = ['categories', 'categorySuggestions', 'sections'];

  const candidates: Record<string, unknown>[] = [];

  const direct = attemptParse(raw);
  if (direct) {
    candidates.push(direct);
  }

  if (!direct) {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const nested = attemptParse(jsonMatch[0]);
      if (nested) {
        candidates.push(nested);
      }
    }
  }

  for (const candidate of candidates) {
    let keywords: string[] = [];
    for (const key of keywordKeys) {
      if (key in candidate) {
        keywords = normalizeStringList(candidate[key]);
      }
      if (keywords.length > 0) {
        break;
      }
    }

    let categories: string[] = [];
    for (const key of categoryKeys) {
      if (key in candidate) {
        categories = normalizeStringList(candidate[key]);
      }
      if (categories.length > 0) {
        break;
      }
    }

    if (keywords.length > 0 || categories.length > 0) {
      return { keywords, categories };
    }
  }

  const fallbackKeywords = extractSectionList(raw, [
    'keywords',
    'keyword ideas',
    'topics',
    'key phrases',
    'search terms',
  ]);
  const fallbackCategories = extractSectionList(raw, [
    'categories',
    'category suggestions',
    'recommended categories',
    'sections',
  ]);

  return { keywords: fallbackKeywords, categories: fallbackCategories };
}

function fallbackKeywordsFromDescription(
  description: string,
  limit: number
): string[] {
  const tokens = description
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }

    seen.add(lowered);
    normalized.push(token);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

function sanitizeDescriptionQuery(description: string): string {
  if (!description) {
    return '';
  }

  const normalized = description.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= MAX_DESCRIPTION_QUERY_LENGTH) {
    return normalized;
  }

  const truncated = normalized.slice(0, MAX_DESCRIPTION_QUERY_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > MAX_DESCRIPTION_QUERY_LENGTH * 0.6) {
    return truncated.slice(0, lastSpace).trim();
  }

  return truncated.trim();
}

async function inferKeywordsAndCategories(
  client: OpenAIClient,
  description: string,
  requestedLimit: number
): Promise<{ keywords: string[]; categories: CategoryValue[] }> {
  const keywordTarget = Math.min(
    MAX_FILTER_LIST_ITEMS,
    Math.max(4, Math.ceil(requestedLimit * 1.5))
  );
  const allowedCategories = Array.from(CATEGORY_SET.values()).join(', ');
  const systemPrompt =
    'You analyze news-focused website descriptions to recommend search keywords and NewsAPI categories. ' +
    'Always respond with a valid JSON object that only contains "keywords" and "categories" properties. ' +
    'Keywords should be short search phrases suitable for the NewsAPI everything endpoint.';
  const userPrompt =
    `The description of the news site is:\n"""${description}"""\n\n` +
    `Return around ${keywordTarget} diverse keywords capturing geographic, topical, and audience angles. ` +
    'Include up to 4 categories drawn from the following list when relevant: ' +
    `${allowedCategories}. ` +
    'Format: {"keywords": [..], "categories": [..]}.';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens: 400,
  });

  const content = response.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = parseKeywordCategoryResponse(content);

  let keywords = normalizeStringList(parsed.keywords, {
    limit: keywordTarget,
    lowercaseDedup: true,
  });

  if (keywords.length === 0) {
    keywords = fallbackKeywordsFromDescription(description, keywordTarget);
  }

  if (keywords.length === 0) {
    throw new Error('No keywords returned from OpenAI');
  }

  let categories = normalizeStringList(parsed.categories, {
    limit: 4,
    lowercaseDedup: true,
  })
    .map((value) => value.toLowerCase())
    .filter((value): value is CategoryValue =>
      CATEGORY_SET.has(value as CategoryValue)
    );

  if (categories.length === 0) {
    const loweredDescription = description.toLowerCase();
    const inferred = new Set<CategoryValue>();
    CATEGORY_SET.forEach((option) => {
      if (loweredDescription.includes(option)) {
        inferred.add(option);
      }
    });
    categories = Array.from(inferred).slice(0, 4);
  }

  return { keywords, categories };
}

async function generateKeywordQueries(
  client: OpenAIClient,
  keywords: string[],
  requestedLimit: number
): Promise<string[]> {
  const maxSuggestions = Math.min(5, Math.max(1, Math.ceil(requestedLimit / 3)));
  const systemPrompt =
    'You convert curated keyword lists into complementary NewsAPI search strings. Each query should be ready for the "q" parameter, make use of phrase quoting and Boolean operators, and encourage coverage from distinct angles.';
  const userPrompt = `Convert the following keywords into ${maxSuggestions} or fewer NewsAPI search strings. ` +
    'Create variations that explore breaking developments, analytical or research-heavy coverage, and human impact or business implications when they make sense. ' +
    'Use operators like AND, OR, and parentheses to pair or contrast the provided ideas, and prefer double quotes around multi-word phrases. ' +
    'Respond with a JSON array of strings only. Keywords:\n' +
    keywords.map((keyword, index) => `${index + 1}. ${keyword}`).join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 200,
  });

  const content =
    response.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = parseGeneratedQueries(content);

  const unique = Array.from(new Set(parsed.map((value) => value.trim()).filter(Boolean)));

  if (unique.length > 0) {
    return unique.slice(0, 10);
  }

  if (keywords.length === 1) {
    return [`"${keywords[0]}"`];
  }

  return [
    keywords
      .map((keyword) => (keyword.includes(' ') ? `"${keyword}"` : keyword))
      .join(' AND '),
  ];
}

type HeadlineSummary = {
  overview: string;
  bullets: string[];
};

type RelatedArticle = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
};

type NormalizedHeadline = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
};

type HeadlineResponseEntry = NormalizedHeadline & {
  summary?: HeadlineSummary;
  relatedArticles?: RelatedArticle[];
  ranking?: HeadlineRankingMetadata;
};

type HeadlineCandidate = {
  data: NormalizedHeadline;
  normalizedUrl: string;
  normalizedTitle: string;
  tokenSet: Set<string>;
  normalizedDescription: string;
  related: RelatedArticle[];
};

type HeadlineRankingComponents = {
  recency: number;
  sourceDiversity: number;
  topicCoverage: number;
};

type HeadlineRankingMetadata = {
  score: number;
  components: HeadlineRankingComponents;
  details: {
    ageHours: number | null;
    sourceOccurrences: number;
    uniqueTokenRatio: number;
  };
  reasons: string[];
};

type RankedHeadlineCandidate = {
  candidate: HeadlineCandidate;
  ranking: HeadlineRankingMetadata;
};

const TOKEN_MIN_LENGTH = 3;
const MAX_TOKEN_COUNT = 64;
const TOKEN_OVERLAP_THRESHOLD = 0.7;
const RANKING_RECENCY_WEIGHT = 0.5;
const RANKING_SOURCE_WEIGHT = 0.25;
const RANKING_TOPIC_WEIGHT = 0.25;

function normalizeUrlForComparison(url: string): string {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    return `${parsed.protocol}//${parsed.hostname}${normalizedPath}`
      .replace(/\/+$/g, '')
      .toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeHeadlineText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildTokenSet(title: string, description: string): Set<string> {
  const combined = `${title} ${description}`;
  const rawTokens = combined
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= TOKEN_MIN_LENGTH);

  const tokenSet = new Set<string>();
  for (const token of rawTokens) {
    if (!token) {
      continue;
    }
    tokenSet.add(token);
    if (tokenSet.size >= MAX_TOKEN_COUNT) {
      break;
    }
  }

  return tokenSet;
}

function computeTokenOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;

  let intersection = 0;
  smaller.forEach((token) => {
    if (larger.has(token)) {
      intersection += 1;
    }
  });

  return intersection / Math.max(1, smaller.size);
}

function areHeadlinesNearDuplicate(a: HeadlineCandidate, b: HeadlineCandidate): boolean {
  if (a.normalizedUrl && b.normalizedUrl && a.normalizedUrl === b.normalizedUrl) {
    return true;
  }

  if (
    a.normalizedTitle &&
    b.normalizedTitle &&
    a.normalizedTitle === b.normalizedTitle
  ) {
    return true;
  }

  if (
    a.normalizedDescription &&
    b.normalizedDescription &&
    a.normalizedDescription === b.normalizedDescription
  ) {
    return true;
  }

  const overlap = computeTokenOverlapRatio(a.tokenSet, b.tokenSet);
  if (overlap >= TOKEN_OVERLAP_THRESHOLD) {
    return true;
  }

  return false;
}

function createHeadlineCandidate(headline: NormalizedHeadline): HeadlineCandidate {
  return {
    data: headline,
    normalizedUrl: normalizeUrlForComparison(headline.url),
    normalizedTitle: normalizeHeadlineText(headline.title),
    normalizedDescription: normalizeHeadlineText(headline.description),
    tokenSet: buildTokenSet(headline.title, headline.description),
    related: [],
  };
}

function addHeadlineIfUnique(
  aggregated: HeadlineCandidate[],
  candidate: NormalizedHeadline
): boolean {
  const enriched = createHeadlineCandidate(candidate);

  for (const existing of aggregated) {
    if (areHeadlinesNearDuplicate(existing, enriched)) {
      const normalizedCandidateUrl = normalizeUrlForComparison(candidate.url);
      if (
        normalizedCandidateUrl &&
        (normalizedCandidateUrl === existing.normalizedUrl ||
          existing.related.some(
            (relatedArticle) =>
              normalizeUrlForComparison(relatedArticle.url) === normalizedCandidateUrl
          ))
      ) {
        return false;
      }

      if (
        candidate.description &&
        candidate.description.length > existing.data.description.length
      ) {
        existing.data.description = candidate.description;
        existing.normalizedDescription = normalizeHeadlineText(candidate.description);
      }

      existing.related.push({
        title: candidate.title,
        description: candidate.description,
        url: candidate.url,
        source: candidate.source,
        publishedAt: candidate.publishedAt,
      });

      for (const token of enriched.tokenSet) {
        existing.tokenSet.add(token);
      }

      return false;
    }
  }

  aggregated.push(enriched);
  return true;
}

function computeRecencyScore(publishedAt: string): {
  score: number;
  ageHours: number | null;
} {
  if (!publishedAt) {
    return { score: 0, ageHours: null };
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return { score: 0, ageHours: null };
  }

  const now = Date.now();
  const ageHours = Math.max(0, (now - parsed) / (1000 * 60 * 60));
  const maxHours = 72;
  const clamped = Math.min(ageHours, maxHours);
  const score = Number.isFinite(clamped) ? 1 - clamped / maxHours : 0;
  return { score, ageHours };
}

function computeSourceDiversityScore(
  occurrences: number
): { score: number } {
  if (!Number.isFinite(occurrences) || occurrences <= 0) {
    return { score: 0 };
  }

  const score = 1 / occurrences;
  return { score };
}

function computeTopicCoverageScore(
  tokenSet: Set<string>,
  tokenFrequency: Map<string, number>
): { score: number; ratio: number } {
  if (tokenSet.size === 0) {
    return { score: 0, ratio: 0 };
  }

  let uniqueTokens = 0;
  tokenSet.forEach((token) => {
    if ((tokenFrequency.get(token) ?? 0) <= 1) {
      uniqueTokens += 1;
    }
  });

  const ratio = uniqueTokens / Math.max(1, tokenSet.size);
  return { score: ratio, ratio };
}

function buildRankingReasons(metadata: HeadlineRankingMetadata): string[] {
  const reasons: string[] = [];

  if (metadata.details.ageHours !== null) {
    if (metadata.components.recency >= 0.75) {
      reasons.push('Published within the last 18 hours');
    } else if (metadata.components.recency >= 0.5) {
      reasons.push('Published recently');
    } else if (metadata.components.recency <= 0.1) {
      reasons.push('Older coverage');
    }
  }

  if (metadata.components.sourceDiversity >= 0.75) {
    reasons.push('Unique source in this set');
  } else if (metadata.components.sourceDiversity <= 0.25) {
    reasons.push('Source appears multiple times');
  }

  if (metadata.components.topicCoverage >= 0.6) {
    reasons.push('Adds distinct topic details');
  } else if (metadata.components.topicCoverage <= 0.2) {
    reasons.push('Overlaps heavily with other articles');
  }

  return reasons;
}

function rankHeadlineCandidates(
  candidates: HeadlineCandidate[]
): RankedHeadlineCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  const sourceFrequency = new Map<string, number>();
  const tokenFrequency = new Map<string, number>();

  candidates.forEach((candidate) => {
    const sourceKey = candidate.data.source.trim().toLowerCase() || 'unknown';
    sourceFrequency.set(sourceKey, (sourceFrequency.get(sourceKey) ?? 0) + 1);

    candidate.tokenSet.forEach((token) => {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    });
  });

  const scored = candidates.map((candidate, index) => {
    const sourceKey = candidate.data.source.trim().toLowerCase() || 'unknown';
    const sourceOccurrences = sourceFrequency.get(sourceKey) ?? 1;

    const recency = computeRecencyScore(candidate.data.publishedAt);
    const source = computeSourceDiversityScore(sourceOccurrences);
    const topic = computeTopicCoverageScore(candidate.tokenSet, tokenFrequency);

    const score =
      recency.score * RANKING_RECENCY_WEIGHT +
      source.score * RANKING_SOURCE_WEIGHT +
      topic.score * RANKING_TOPIC_WEIGHT;

    const metadata: HeadlineRankingMetadata = {
      score,
      components: {
        recency: recency.score,
        sourceDiversity: source.score,
        topicCoverage: topic.score,
      },
      details: {
        ageHours: recency.ageHours,
        sourceOccurrences,
        uniqueTokenRatio: topic.ratio,
      },
      reasons: [],
    };

    metadata.reasons = buildRankingReasons(metadata);

    return {
      candidate,
      ranking: metadata,
      index,
    };
  });

  scored.sort((a, b) => {
    if (b.ranking.score !== a.ranking.score) {
      return b.ranking.score - a.ranking.score;
    }

    const aAge = a.ranking.details.ageHours;
    const bAge = b.ranking.details.ageHours;
    if (aAge !== null || bAge !== null) {
      const normalizedAAge = aAge === null ? Number.POSITIVE_INFINITY : aAge;
      const normalizedBAge = bAge === null ? Number.POSITIVE_INFINITY : bAge;
      if (normalizedAAge !== normalizedBAge) {
        return normalizedAAge - normalizedBAge;
      }
    }

    return a.index - b.index;
  });

  return scored.map(({ index: _index, ...rest }) => rest);
}

function condenseText(value: string, maxLength = 400): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

type SummaryClusterArticle = {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  summary: string;
};

type SummaryClusterInput = {
  id: string;
  headline: string;
  articles: SummaryClusterArticle[];
};

async function generateClusterSummaries(
  client: OpenAIClient,
  clusters: HeadlineCandidate[],
  log: Pick<typeof console, 'error'>
): Promise<Record<string, HeadlineSummary>> {
  if (clusters.length === 0) {
    return {};
  }

  const inputs: SummaryClusterInput[] = clusters.map((cluster, index) => {
    const id = `item-${index}`;
    const collected: SummaryClusterArticle[] = [];
    const sources: RelatedArticle[] = [
      {
        title: cluster.data.title,
        description: cluster.data.description,
        url: cluster.data.url,
        source: cluster.data.source,
        publishedAt: cluster.data.publishedAt,
      },
      ...cluster.related,
    ];

    for (const article of sources) {
      const snippet = condenseText(article.description || article.title || '');
      if (!snippet) {
        continue;
      }
      collected.push({
        title: article.title,
        source: article.source,
        publishedAt: article.publishedAt,
        url: article.url,
        summary: snippet,
      });
      if (collected.length >= 6) {
        break;
      }
    }

    if (collected.length === 0) {
      const fallbackTitle = cluster.data.title.trim() || 'Untitled report';
      collected.push({
        title: fallbackTitle,
        source: cluster.data.source,
        publishedAt: cluster.data.publishedAt,
        url: cluster.data.url,
        summary:
          condenseText(cluster.data.description) ||
          condenseText(fallbackTitle) ||
          fallbackTitle,
      });
    }

    return {
      id,
      headline: cluster.data.title,
      articles: collected,
    };
  });

  const serialized = JSON.stringify(inputs, null, 2);

  let content = '';
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a meticulous news editor. For each cluster of related articles, craft a 2-3 sentence overview capturing the key development and context. Also produce 3-5 concise factual bullet points highlighting distinct details. Only use the provided information. Return strict JSON with the shape {"<cluster-id>": {"overview": string, "bullets": string[]}} with no extra commentary.',
        },
        {
          role: 'user',
          content: `Summarize the following news clusters:\n${serialized}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 600,
    });

    content = response.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (error) {
    log.error('[api/headlines] summarization request failed', error);
    return {};
  }

  if (!content) {
    return {};
  }

  const cleaned = content.replace(/```json|```/g, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    log.error('[api/headlines] failed to parse summarization response', error);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const result: Record<string, HeadlineSummary> = {};

  for (const [id, value] of Object.entries(parsed as Record<string, any>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const overview = typeof value.overview === 'string' ? value.overview.trim() : '';
    const bullets = Array.isArray(value.bullets)
      ? value.bullets
          .map((entry: unknown) =>
            typeof entry === 'string' ? entry.trim() : entry ? String(entry).trim() : ''
          )
          .filter((entry: string) => Boolean(entry))
          .slice(0, 5)
      : [];

    if (!overview && bullets.length === 0) {
      continue;
    }

    result[id] = {
      overview,
      bullets,
    };
  }

  return result;
}

async function buildHeadlineResponses(
  ranked: RankedHeadlineCandidate[],
  client: OpenAIClient,
  log: Pick<typeof console, 'error'>
): Promise<HeadlineResponseEntry[]> {
  if (ranked.length === 0) {
    return [];
  }

  const candidates = ranked.map((entry) => entry.candidate);
  const summaries = await generateClusterSummaries(client, candidates, log);

  return ranked.map((entry, index) => {
    const { candidate, ranking } = entry;
    const summary = summaries[`item-${index}`];
    const relatedArticles = candidate.related.length > 0
      ? candidate.related.map((article) => ({ ...article }))
      : undefined;

    return {
      title: candidate.data.title,
      description: candidate.data.description,
      url: candidate.data.url,
      source: candidate.data.source,
      publishedAt: candidate.data.publishedAt,
      summary,
      relatedArticles,
      ranking,
    };
  });
}

function normalizeSerpResult(result: SerpApiResult): NormalizedHeadline | null {
  const title = (result?.title ?? '').trim();
  const url = (result?.link ?? '').trim();

  if (!title || !url) {
    return null;
  }

  const description = (result?.snippet ?? '').trim();
  const source = (result?.source ?? '').trim();
  const publishedAt = (result?.date ?? result?.published_at ?? '').trim();

  return {
    title,
    description,
    url,
    source,
    publishedAt,
  };
}

function computeSerpTimeFilter(
  from: string | null,
  to: string | null
): string | undefined {
  if (!from) {
    return undefined;
  }

  const fromDate = new Date(from);
  if (Number.isNaN(fromDate.getTime())) {
    return undefined;
  }

  const now = to ? new Date(to) : new Date();
  if (Number.isNaN(now.getTime())) {
    return undefined;
  }

  const diffHours = Math.max(0, (now.getTime() - fromDate.getTime()) / (1000 * 60 * 60));

  if (diffHours <= 1) {
    return 'qdr:h';
  }
  if (diffHours <= 6) {
    return 'qdr:h6';
  }
  if (diffHours <= 24) {
    return 'qdr:d';
  }
  if (diffHours <= 24 * 7) {
    return 'qdr:w';
  }
  if (diffHours <= 24 * 30) {
    return 'qdr:m';
  }

  return 'qdr:y';
}

function createHeadlinesHandler(
  { fetchImpl, openaiClient, logger }: HeadlinesHandlerDependencies = {}
) {
  const requester = fetchImpl ?? fetch;
  const aiClient = openaiClient ?? openai;
  const log = (logger ?? console) as Pick<typeof console, 'error'>;

  return async function handler(req: NextRequest) {
  let body: HeadlinesRequestBody;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';

  let keywords: string[];
  try {
    keywords = normalizeKeywords(body.keywords);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid keywords parameter'
    );
  }

  let description = '';
  if (body.description === undefined || body.description === null) {
    description = '';
  } else if (typeof body.description === 'string') {
    description = body.description.trim();
  } else {
    return badRequest('description must be a string value');
  }

  let category: CategoryValue | null;
  try {
    category = normalizeCategory(body.category);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid category parameter'
    );
  }

  let country: CountryCode | null;
  try {
    country = normalizeCountry(body.country);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid country parameter'
    );
  }

  if (country && !category) {
    return badRequest('country can only be used when a category is selected');
  }

  const isCategoryRequest = category !== null;

  if (!query && keywords.length === 0 && !description && !isCategoryRequest) {
    return badRequest('Either query, keywords, or description must be provided');
  }

  const limit = resolveLimit(body.limit);

  let language: LanguageCode | null | undefined;
  try {
    language = normalizeLanguage(body.language);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid language parameter'
    );
  }

  let sortBy: SortBy;
  try {
    sortBy = normalizeSortBy(body.sortBy);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid sortBy parameter'
    );
  }

  let from: string | null;
  let to: string | null;
  try {
    from = normalizeDate(body.from, 'from');
    to = normalizeDate(body.to, 'to');
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid date filters'
    );
  }

  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    return badRequest('from must be earlier than or equal to to');
  }

  let searchInValues: SearchInValue[];
  try {
    searchInValues = normalizeSearchIn(body.searchIn);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid searchIn parameter'
    );
  }

  let sources: string[];
  let domains: string[];
  let excludeDomains: string[];
  try {
    sources = normalizeSources(body.sources);
    domains = normalizeDomains(body.domains, 'domains');
    excludeDomains = normalizeDomains(body.excludeDomains, 'excludeDomains');
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid domain filters'
    );
  }

  if (sources.length > 0 && (domains.length > 0 || excludeDomains.length > 0)) {
    return badRequest('sources cannot be combined with domains or excludeDomains');
  }

  const apiKey = process.env.NEWSAPI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'NEWSAPI_API_KEY is not configured' },
      { status: 500 }
    );
  }

  if (isCategoryRequest && sources.length > 0) {
    return badRequest('Category feeds cannot be combined with specific sources');
  }

  let inferenceResult: { keywords: string[]; categories: CategoryValue[] } | null =
    null;

  if (!isCategoryRequest && keywords.length === 0 && description) {
    try {
      inferenceResult = await inferKeywordsAndCategories(
        aiClient,
        description,
        limit
      );
      keywords = inferenceResult.keywords;
    } catch (error) {
      log.error('[api/headlines] keyword inference failed', error);
      return NextResponse.json(
        { error: 'Failed to infer keywords from description' },
        { status: 502 }
      );
    }

    if (keywords.length === 0) {
      return badRequest('Unable to infer keywords from the provided description');
    }
  }

  if (isCategoryRequest) {
    const requestUrl = new URL('https://newsapi.org/v2/top-headlines');
    requestUrl.searchParams.set('category', category);
    requestUrl.searchParams.set('pageSize', String(Math.max(1, limit)));
    requestUrl.searchParams.set('page', '1');

    if (country) {
      requestUrl.searchParams.set('country', country);
    }

    if (query) {
      requestUrl.searchParams.set('q', query);
    }

    const requestLabelParts = [`category:${category}`];
    if (country) {
      requestLabelParts.push(`country:${country}`);
    }
    if (query) {
      requestLabelParts.push(`q:${query}`);
    }
    const requestLabel = requestLabelParts.join(' ');
    const queriesAttempted = [requestLabel];

    let response: Response;
    try {
      response = await requester(requestUrl, {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
        },
      });
    } catch (error) {
      log.error('[api/headlines] category request failed', error);
      return NextResponse.json(
        {
          error: 'Failed to reach NewsAPI for the requested category feed',
          queryErrors: [`Failed to reach NewsAPI for request: ${requestLabel}`],
          queriesAttempted,
        },
        { status: 502 }
      );
    }

    let data: any = null;
    try {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = text ? { message: text } : null;
      }
    } catch (error) {
      log.error('[api/headlines] failed to parse category response', error);
      const queryErrors = [`Invalid response from NewsAPI for request: ${requestLabel}`];
      if (!response.ok) {
        return NextResponse.json(
          {
            error: `NewsAPI request failed for category feed: ${requestLabel}`,
            queryErrors,
            queriesAttempted,
          },
          { status: 502 }
        );
      }

      return NextResponse.json(
        {
          error: 'Invalid response from NewsAPI for the requested category feed',
          queryErrors,
          queriesAttempted,
        },
        { status: 502 }
      );
    }

    if (!response.ok) {
      const message =
        (data && typeof data.message === 'string' && data.message) ||
        'NewsAPI request failed';
      return NextResponse.json(
        {
          error: `NewsAPI error for category feed: ${message}`,
          queryErrors: [`NewsAPI error for request: ${requestLabel}`],
          queriesAttempted,
        },
        { status: 502 }
      );
    }

    if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
      return NextResponse.json(
        {
          error: `Unexpected response from NewsAPI for request: ${requestLabel}`,
          queryErrors: [`Unexpected response from NewsAPI for request: ${requestLabel}`],
          queriesAttempted,
        },
        { status: 502 }
      );
    }

    const aggregatedHeadlines: HeadlineCandidate[] = [];

    for (const article of data.articles) {
      const normalized: NormalizedHeadline = {
        title: article?.title ?? '',
        description: article?.description ?? article?.content ?? '',
        url: article?.url ?? '',
        source: article?.source?.name ?? '',
        publishedAt: article?.publishedAt ?? article?.published_at ?? '',
      };

      if (!normalized.title || !normalized.url) {
        continue;
      }

      addHeadlineIfUnique(aggregatedHeadlines, normalized);

      if (aggregatedHeadlines.length >= limit) {
        break;
      }
    }

    const queryWarnings: string[] = [];
    if (aggregatedHeadlines.length === 0) {
      queryWarnings.push('No headlines returned for the selected category feed.');
    }

    const rankedCandidates = rankHeadlineCandidates(aggregatedHeadlines);
    const topRanked = rankedCandidates.slice(0, limit);
    const headlinesWithSummaries = await buildHeadlineResponses(
      topRanked,
      aiClient,
      log
    );

    const payload: Record<string, unknown> = {
      headlines: headlinesWithSummaries,
      totalResults: aggregatedHeadlines.length,
      queriesAttempted,
      successfulQueries: 1,
    };

    if (rankedCandidates.length > 0) {
      payload.ranking = {
        totalRanked: rankedCandidates.length,
        weights: {
          recency: RANKING_RECENCY_WEIGHT,
          sourceDiversity: RANKING_SOURCE_WEIGHT,
          topicCoverage: RANKING_TOPIC_WEIGHT,
        },
      };
    }

    if (inferenceResult) {
      payload.inferredKeywords = inferenceResult.keywords;
      payload.inferredCategories = inferenceResult.categories;
    }

    if (queryWarnings.length > 0) {
      payload.warnings = queryWarnings;
    }

    return NextResponse.json(payload);
  }

  let keywordQueries: string[] = [];
  if (keywords.length > 0) {
    try {
      keywordQueries = await generateKeywordQueries(aiClient, keywords, limit);
    } catch (error) {
      log.error('[api/headlines] keyword expansion failed', error);
      return NextResponse.json(
        { error: 'Failed to expand keyword searches' },
        { status: 502 }
      );
    }
  }

  const descriptionQuery = !query && description
    ? sanitizeDescriptionQuery(description)
    : '';

  const searchQueries = Array.from(
    new Set(
      [query, descriptionQuery, ...keywordQueries]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );

  if (searchQueries.length === 0) {
    searchQueries.push(
      keywords
        .map((keyword) => (keyword.includes(' ') ? `"${keyword}"` : keyword))
        .join(' AND ')
    );
  }

  const buildUrl = (q: string, pageSize: number, page = 1) => {
    const requestUrl = new URL('https://newsapi.org/v2/everything');
    requestUrl.searchParams.set('q', q);
    requestUrl.searchParams.set('pageSize', String(Math.max(1, pageSize)));
    const normalizedPage =
      Number.isFinite(page) && page ? Math.max(1, Math.trunc(page)) : 1;
    requestUrl.searchParams.set('page', String(normalizedPage));
    requestUrl.searchParams.set('sortBy', sortBy);

    if (language === undefined) {
      requestUrl.searchParams.set('language', 'en');
    } else if (language !== null) {
      requestUrl.searchParams.set('language', language);
    }

    if (from) {
      requestUrl.searchParams.set('from', from);
    }

    if (to) {
      requestUrl.searchParams.set('to', to);
    }

    if (searchInValues.length > 0) {
      requestUrl.searchParams.set('searchIn', searchInValues.join(','));
    }

    if (sources.length > 0) {
      requestUrl.searchParams.set('sources', sources.join(','));
    }

    if (domains.length > 0) {
      requestUrl.searchParams.set('domains', domains.join(','));
    }

    if (excludeDomains.length > 0) {
      requestUrl.searchParams.set('excludeDomains', excludeDomains.join(','));
    }

    return requestUrl;
  };

  const aggregatedHeadlines: HeadlineCandidate[] = [];
  const queriesAttempted: string[] = [];
  const queryWarnings: string[] = [];
  let successfulQueries = 0;
  const perQuery = Math.max(
    1,
    Math.ceil(limit / Math.max(1, searchQueries.length))
  );
  const serpApiConfigured = Boolean(process.env.SERPAPI_KEY);
  const serpTimeFilter = computeSerpTimeFilter(from, to);

  for (const search of searchQueries) {
    if (aggregatedHeadlines.length >= limit) {
      break;
    }

    queriesAttempted.push(search);
    let page = 1;
    let querySucceeded = false;

    while (aggregatedHeadlines.length < limit) {
      const remaining = limit - aggregatedHeadlines.length;
      const pageSize = Math.min(remaining, perQuery);
      const requestUrl = buildUrl(search, pageSize, page);

      let response: Response;
      try {
        response = await requester(requestUrl, {
          method: 'GET',
          headers: {
            'X-Api-Key': apiKey,
          },
        });
      } catch (error) {
        log.error('[api/headlines] request failed', error);
        queryWarnings.push(`Failed to reach NewsAPI for query: ${search}`);
        break;
      }

      let data: any = null;
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const text = await response.text();
          data = text ? { message: text } : null;
        }
      } catch (error) {
        log.error('[api/headlines] failed to parse response', error);
        if (!response.ok) {
          queryWarnings.push(
            `NewsAPI request failed for query: ${search} (status ${response.status || 502})`
          );
          break;
        }
        queryWarnings.push(`Invalid response from NewsAPI for query: ${search}`);
        break;
      }

      if (!response.ok) {
        const message =
          (data && typeof data.message === 'string' && data.message) ||
          'NewsAPI request failed';
        queryWarnings.push(`NewsAPI error for query "${search}": ${message}`);
        break;
      }

      if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
        queryWarnings.push(`Unexpected response from NewsAPI for query: ${search}`);
        break;
      }

      querySucceeded = true;

      const beforeAdd = aggregatedHeadlines.length;

      for (const article of data.articles) {
        const normalized: NormalizedHeadline = {
          title: article?.title ?? '',
          description: article?.description ?? article?.content ?? '',
          url: article?.url ?? '',
          source: article?.source?.name ?? '',
          publishedAt: article?.publishedAt ?? article?.published_at ?? '',
        };

        if (!normalized.title || !normalized.url) {
          continue;
        }

        addHeadlineIfUnique(aggregatedHeadlines, normalized);

        if (aggregatedHeadlines.length >= limit) {
          break;
        }
      }

      if (aggregatedHeadlines.length >= limit) {
        break;
      }

      const receivedCount = Array.isArray(data.articles)
        ? data.articles.length
        : 0;
      const addedCount = aggregatedHeadlines.length - beforeAdd;

      if (addedCount === 0 || receivedCount < pageSize) {
        break;
      }

      page += 1;
    }

    if (serpApiConfigured && aggregatedHeadlines.length < limit) {
      const baseParams: Record<string, string> = {};

      if (language && language !== null) {
        baseParams.hl = language;
      }

      if (country) {
        baseParams.gl = country;
      }

      if (serpTimeFilter) {
        baseParams.tbs = serpTimeFilter;
      }

      const serpEngines: Array<{
        engine: string;
        limit: number;
        params: Record<string, string>;
      }> = [
        {
          engine: 'google_news',
          limit: Math.max(6, perQuery * 2),
          params: {
            ...baseParams,
            num: String(Math.max(6, perQuery * 2)),
          },
        },
      ];

      if (aggregatedHeadlines.length < limit) {
        serpEngines.push({
          engine: 'google',
          limit: Math.max(5, perQuery),
          params: {
            ...baseParams,
            num: String(Math.max(5, perQuery)),
          },
        });
      }

      for (const { engine, limit: serpLimit, params } of serpEngines) {
        if (aggregatedHeadlines.length >= limit) {
          break;
        }

        const serpResults = await serpapiSearch({
          query: search,
          engine,
          extraParams: params,
          limit: serpLimit,
        });

        for (const result of serpResults) {
          if (aggregatedHeadlines.length >= limit) {
            break;
          }

          const normalized = normalizeSerpResult(result);
          if (!normalized) {
            continue;
          }

          addHeadlineIfUnique(aggregatedHeadlines, normalized);
        }
      }
    }

    if (querySucceeded) {
      successfulQueries += 1;
    }

    if (aggregatedHeadlines.length >= limit) {
      break;
    }
  }

  if (successfulQueries === 0 && aggregatedHeadlines.length === 0) {
    const message =
      queryWarnings[0] || 'NewsAPI request failed for all generated queries';
    const errorPayload: Record<string, unknown> = {
      error: message,
      queryErrors: queryWarnings,
      queriesAttempted,
    };

    if (inferenceResult) {
      errorPayload.inferredKeywords = inferenceResult.keywords;
      errorPayload.inferredCategories = inferenceResult.categories;
    }

    return NextResponse.json(errorPayload, { status: 502 });
  }

  const rankedCandidates = rankHeadlineCandidates(aggregatedHeadlines);
  const topRanked = rankedCandidates.slice(0, limit);
  const headlinesWithSummaries = await buildHeadlineResponses(
    topRanked,
    aiClient,
    log
  );

  const payload: Record<string, unknown> = {
    headlines: headlinesWithSummaries,
    totalResults: aggregatedHeadlines.length,
    queriesAttempted,
    successfulQueries,
  };

  if (rankedCandidates.length > 0) {
    payload.ranking = {
      totalRanked: rankedCandidates.length,
      weights: {
        recency: RANKING_RECENCY_WEIGHT,
        sourceDiversity: RANKING_SOURCE_WEIGHT,
        topicCoverage: RANKING_TOPIC_WEIGHT,
      },
    };
  }

  if (inferenceResult) {
    payload.inferredKeywords = inferenceResult.keywords;
    payload.inferredCategories = inferenceResult.categories;
  }

  if (queryWarnings.length > 0) {
    payload.warnings = queryWarnings;
  }

  return NextResponse.json(payload);
  };
}

export const POST = createHeadlinesHandler();
