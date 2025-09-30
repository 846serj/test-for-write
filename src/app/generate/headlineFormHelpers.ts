import { isCategoryFeedValue } from '../../constants/categoryFeeds';

const MAX_LIST_ITEMS = 20;
const MAX_RSS_FEEDS = 10;
const ALLOWED_RSS_PROTOCOLS = new Set(['http:', 'https:']);

export const SEARCH_IN_ORDER = ['title', 'description', 'content'] as const;

export type SortByValue = 'publishedAt' | 'relevancy' | 'popularity';

export type BuildHeadlineRequestArgs = {
  keywords: string[];
  profileQuery: string;
  profileLanguage?: string | null;
  limit: number;
  sortBy: SortByValue;
  language: string;
  fromDate: string;
  toDate: string;
  searchIn: string[];
  sourcesInput: string;
  domainsInput: string;
  excludeDomainsInput: string;
  category: string;
  country: string;
  description: string;
  rssFeeds?: string[];
};

export type BuildHeadlineRequestBaseResult = {
  sanitizedSources: string[];
  sanitizedDomains: string[];
  sanitizedExcludeDomains: string[];
  sanitizedRssFeeds: string[];
};

export type BuildHeadlineRequestSuccess = BuildHeadlineRequestBaseResult & {
  ok: true;
  payload: Record<string, unknown>;
};

export type BuildHeadlineRequestError = BuildHeadlineRequestBaseResult & {
  ok: false;
  error: string;
};

export type BuildHeadlineRequestResult =
  | BuildHeadlineRequestSuccess
  | BuildHeadlineRequestError;

export function sanitizeListInput(
  value: string,
  { lowercase }: { lowercase?: boolean } = {}
) {
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (lowercase ? item.toLowerCase() : item));

  return Array.from(new Set(entries)).slice(0, MAX_LIST_ITEMS);
}

function sanitizeRssFeeds(feeds: string[] | undefined): string[] {
  if (!Array.isArray(feeds) || feeds.length === 0) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of feeds) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      if (!ALLOWED_RSS_PROTOCOLS.has(parsed.protocol)) {
        continue;
      }

      const normalizedUrl = parsed.toString();
      const key = normalizedUrl.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalized.push(normalizedUrl);

      if (normalized.length >= MAX_RSS_FEEDS) {
        break;
      }
    } catch {
      continue;
    }
  }

  return normalized;
}

export function normalizeKeywordInput(value: string): string[] {
  const segments = value
    .split(/[\n,]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const segment of segments) {
    const lowered = segment.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    normalized.push(segment);
    if (normalized.length >= MAX_LIST_ITEMS) {
      break;
    }
  }

  return normalized;
}

function clampDateValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { raw: '', timestamp: Number.NaN };
  }

  const timestamp = Date.parse(trimmed);
  return { raw: trimmed, timestamp };
}

function normalizeLanguage(
  language: string,
  profileLanguage?: string | null
): string | null {
  const trimmed = language.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'all') {
    const fallback =
      typeof profileLanguage === 'string' && profileLanguage.trim()
        ? profileLanguage.trim().toLowerCase()
        : '';
    return fallback || null;
  }

  return lowered;
}

export function buildHeadlineRequest(
  args: BuildHeadlineRequestArgs
): BuildHeadlineRequestResult {
  const {
    keywords,
    profileQuery,
    profileLanguage,
    limit,
    sortBy,
    language,
    fromDate,
    toDate,
    searchIn,
    sourcesInput,
    domainsInput,
    excludeDomainsInput,
    category,
    country,
    description,
    rssFeeds,
  } = args;

  const trimmedProfileQuery = profileQuery.trim();
  const hasProfileQuery = Boolean(trimmedProfileQuery);
  const trimmedDescription = description.trim();

  const trimmedCategory = category.trim();
  const normalizedCategory = trimmedCategory.toLowerCase();
  const normalizedCountry = country.trim().toLowerCase();
  const categoryFeedValue = isCategoryFeedValue(normalizedCategory)
    ? normalizedCategory
    : null;

  const sanitizedSources = sanitizeListInput(sourcesInput);
  const sanitizedDomains = sanitizeListInput(domainsInput, { lowercase: true });
  const sanitizedExcludeDomains = sanitizeListInput(excludeDomainsInput, {
    lowercase: true,
  });
  const sanitizedRssFeeds = sanitizeRssFeeds(rssFeeds);

  const baseResult: BuildHeadlineRequestBaseResult = {
    sanitizedSources,
    sanitizedDomains,
    sanitizedExcludeDomains,
    sanitizedRssFeeds,
  };

  if (normalizedCategory && categoryFeedValue === null) {
    return {
      ok: false,
      error: `Unsupported category feed: ${trimmedCategory || category}`,
      ...baseResult,
    };
  }

  if (
    sanitizedSources.length > 0 &&
    (sanitizedDomains.length > 0 || sanitizedExcludeDomains.length > 0)
  ) {
    return {
      ok: false,
      error:
        'Choose either specific sources or domain filters. NewsAPI does not allow combining them.',
      ...baseResult,
    };
  }

  const { raw: fromValue, timestamp: fromTimestamp } = clampDateValue(fromDate);
  const { raw: toValue, timestamp: toTimestamp } = clampDateValue(toDate);

  if (fromValue && Number.isNaN(fromTimestamp)) {
    return {
      ok: false,
      error: 'Please provide a valid "From" date in YYYY-MM-DD format.',
      ...baseResult,
    };
  }

  if (toValue && Number.isNaN(toTimestamp)) {
    return {
      ok: false,
      error: 'Please provide a valid "To" date in YYYY-MM-DD format.',
      ...baseResult,
    };
  }

  if (
    !Number.isNaN(fromTimestamp) &&
    !Number.isNaN(toTimestamp) &&
    fromTimestamp > toTimestamp
  ) {
    return {
      ok: false,
      error: 'The "From" date must be on or before the "To" date.',
      ...baseResult,
    };
  }

  if (
    !hasProfileQuery &&
    keywords.length === 0 &&
    categoryFeedValue === null &&
    !trimmedDescription
  ) {
    return {
      ok: false,
      error:
        'Provide at least one keyword, choose a category feed, or supply custom instructions to fetch headlines.',
      ...baseResult,
    };
  }

  const orderedSearchIn = SEARCH_IN_ORDER.filter((value) =>
    searchIn.includes(value)
  );

  const payload: Record<string, unknown> = {
    limit,
  };

  if (categoryFeedValue !== null) {
    payload.category = categoryFeedValue;
    if (normalizedCountry) {
      payload.country = normalizedCountry;
    }
  } else {
    payload.sortBy = sortBy;
    if (hasProfileQuery) {
      payload.query = trimmedProfileQuery;
    }
    if (keywords.length > 0) {
      payload.keywords = keywords;
    }
  }
  if (categoryFeedValue === null) {
    const normalizedLanguage = normalizeLanguage(language, profileLanguage);
    if (normalizedLanguage) {
      payload.language = normalizedLanguage;
    }

    if (fromValue) {
      payload.from = fromValue;
    }

    if (toValue) {
      payload.to = toValue;
    }

    if (orderedSearchIn.length > 0) {
      payload.searchIn = orderedSearchIn;
    }

    if (sanitizedSources.length > 0) {
      payload.sources = sanitizedSources;
    }

    if (sanitizedDomains.length > 0) {
      payload.domains = sanitizedDomains;
    }

    if (sanitizedExcludeDomains.length > 0) {
      payload.excludeDomains = sanitizedExcludeDomains;
    }
  }

  if (trimmedDescription) {
    payload.description = trimmedDescription;
  }

  if (sanitizedRssFeeds.length > 0) {
    payload.rssFeeds = sanitizedRssFeeds;
  }

  return {
    ok: true,
    payload,
    ...baseResult,
  };
}
