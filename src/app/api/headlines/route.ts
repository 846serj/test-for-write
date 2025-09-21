import { NextRequest, NextResponse } from 'next/server';
import {
  CATEGORY_FEED_SET,
  CATEGORY_FEED_VALUES,
  type CategoryFeedValue,
} from '../../../constants/categoryFeeds';
import { openai } from '../../../lib/openai';

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 5;
const MAX_FILTER_LIST_ITEMS = 20;

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

const CATEGORY_VALUES = CATEGORY_FEED_VALUES;
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
  if (!CATEGORY_SET.has(lowered)) {
    throw new Error(`Unsupported category selection: ${trimmed}`);
  }

  return lowered as CategoryValue;
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

function createHeadlinesHandler(
  { fetchImpl, openaiClient, logger }: HeadlinesHandlerDependencies = {}
) {
  const requester = fetchImpl ?? fetch;
  const aiClient = openaiClient ?? openai;
  const log = logger ?? console;

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

  if (!query && keywords.length === 0 && !isCategoryRequest) {
    return badRequest('Either query or keywords must be provided');
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

    const seenUrls = new Set<string>();
    const aggregatedHeadlines: {
      title: string;
      description: string;
      url: string;
      source: string;
      publishedAt: string;
    }[] = [];

    for (const article of data.articles) {
      const normalized = {
        title: article?.title ?? '',
        description: article?.description ?? article?.content ?? '',
        url: article?.url ?? '',
        source: article?.source?.name ?? '',
        publishedAt: article?.publishedAt ?? article?.published_at ?? '',
      };

      if (!normalized.title || !normalized.url) {
        continue;
      }

      if (seenUrls.has(normalized.url)) {
        continue;
      }

      seenUrls.add(normalized.url);
      aggregatedHeadlines.push(normalized);

      if (aggregatedHeadlines.length >= limit) {
        break;
      }
    }

    const queryWarnings: string[] = [];
    if (aggregatedHeadlines.length === 0) {
      queryWarnings.push('No headlines returned for the selected category feed.');
    }

    const payload: Record<string, unknown> = {
      headlines: aggregatedHeadlines.slice(0, limit),
      totalResults: aggregatedHeadlines.length,
      queriesAttempted,
      successfulQueries: 1,
    };

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

  const searchQueries = Array.from(
    new Set(
      [query, ...keywordQueries]
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

  const seenUrls = new Set<string>();
  const aggregatedHeadlines: {
    title: string;
    description: string;
    url: string;
    source: string;
    publishedAt: string;
  }[] = [];
  const queriesAttempted: string[] = [];
  const queryWarnings: string[] = [];
  let successfulQueries = 0;
  const perQuery = Math.max(
    1,
    Math.ceil(limit / Math.max(1, searchQueries.length))
  );

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
        const normalized = {
          title: article?.title ?? '',
          description: article?.description ?? article?.content ?? '',
          url: article?.url ?? '',
          source: article?.source?.name ?? '',
          publishedAt: article?.publishedAt ?? article?.published_at ?? '',
        };

        if (!normalized.title || !normalized.url) {
          continue;
        }

        if (seenUrls.has(normalized.url)) {
          continue;
        }

        seenUrls.add(normalized.url);
        aggregatedHeadlines.push(normalized);

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

    if (querySucceeded) {
      successfulQueries += 1;
    }
  }

  if (successfulQueries === 0 && aggregatedHeadlines.length === 0) {
    const message =
      queryWarnings[0] || 'NewsAPI request failed for all generated queries';
    return NextResponse.json(
      { error: message, queryErrors: queryWarnings, queriesAttempted },
      { status: 502 }
    );
  }

  const payload: Record<string, unknown> = {
    headlines: aggregatedHeadlines.slice(0, limit),
    totalResults: aggregatedHeadlines.length,
    queriesAttempted,
    successfulQueries,
  };

  if (queryWarnings.length > 0) {
    payload.warnings = queryWarnings;
  }

  return NextResponse.json(payload);
  };
}

export const POST = createHeadlinesHandler();
