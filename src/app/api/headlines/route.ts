import { NextRequest, NextResponse } from 'next/server';

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
  limit?: unknown;
  language?: unknown;
  sortBy?: unknown;
  from?: unknown;
  to?: unknown;
  searchIn?: unknown;
  sources?: unknown;
  domains?: unknown;
  excludeDomains?: unknown;
};

export async function POST(req: NextRequest) {
  let body: HeadlinesRequestBody;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return badRequest('query is required');
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

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', query);
  url.searchParams.set('pageSize', String(limit));
  url.searchParams.set('sortBy', sortBy);

  if (language === undefined) {
    url.searchParams.set('language', 'en');
  } else if (language !== null) {
    url.searchParams.set('language', language);
  }

  if (from) {
    url.searchParams.set('from', from);
  }

  if (to) {
    url.searchParams.set('to', to);
  }

  if (searchInValues.length > 0) {
    url.searchParams.set('searchIn', searchInValues.join(','));
  }

  if (sources.length > 0) {
    url.searchParams.set('sources', sources.join(','));
  }

  if (domains.length > 0) {
    url.searchParams.set('domains', domains.join(','));
  }

  if (excludeDomains.length > 0) {
    url.searchParams.set('excludeDomains', excludeDomains.join(','));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
      },
    });
  } catch (error) {
    console.error('[api/headlines] request failed', error);
    return NextResponse.json(
      { error: 'Failed to reach NewsAPI' },
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
    console.error('[api/headlines] failed to parse response', error);
    if (!response.ok) {
      return NextResponse.json(
        { error: 'NewsAPI request failed' },
        { status: response.status || 502 }
      );
    }
    return NextResponse.json(
      { error: 'Invalid response from NewsAPI' },
      { status: 502 }
    );
  }

  if (!response.ok) {
    const message =
      (data && typeof data.message === 'string' && data.message) ||
      'NewsAPI request failed';
    return NextResponse.json(
      { error: message },
      { status: response.status || 502 }
    );
  }

  if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
    return NextResponse.json(
      { error: 'Unexpected response from NewsAPI' },
      { status: 502 }
    );
  }

  const headlines = data.articles
    .map((article: any) => ({
      title: article?.title ?? '',
      description: article?.description ?? article?.content ?? '',
      url: article?.url ?? '',
      source: article?.source?.name ?? '',
      publishedAt: article?.publishedAt ?? article?.published_at ?? '',
    }))
    .filter((article: any) => article.title && article.url)
    .slice(0, limit);

  return NextResponse.json({ headlines });
}
