import { isCategoryFeedValue } from '../../constants/categoryFeeds';

const MAX_LIST_ITEMS = 20;

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
};

export type BuildHeadlineRequestBaseResult = {
  sanitizedSources: string[];
  sanitizedDomains: string[];
  sanitizedExcludeDomains: string[];
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

export function normalizeSummaryBullets(value: unknown): string[] {
  const bulletSource = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any).bullets)
    ? (value as any).bullets
    : [];

  if (!Array.isArray(bulletSource)) {
    return [];
  }

  const normalized: string[] = [];

  for (const entry of bulletSource) {
    let text = '';
    if (typeof entry === 'string') {
      text = entry;
    } else if (entry !== null && entry !== undefined) {
      text = String(entry);
    }

    const condensed = text.replace(/\s+/g, ' ').trim();
    if (!condensed) {
      continue;
    }

    const words = condensed.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }

    const truncated = words.slice(0, 30).join(' ');
    if (!truncated) {
      continue;
    }

    normalized.push(truncated);
    if (normalized.length >= 5) {
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
  } = args;

  const trimmedProfileQuery = profileQuery.trim();
  const hasProfileQuery = Boolean(trimmedProfileQuery);

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

  if (normalizedCategory && categoryFeedValue === null) {
    return {
      ok: false,
      error: `Unsupported category feed: ${trimmedCategory || category}`,
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
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
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
    };
  }

  const { raw: fromValue, timestamp: fromTimestamp } = clampDateValue(fromDate);
  const { raw: toValue, timestamp: toTimestamp } = clampDateValue(toDate);

  if (fromValue && Number.isNaN(fromTimestamp)) {
    return {
      ok: false,
      error: 'Please provide a valid "From" date in YYYY-MM-DD format.',
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
    };
  }

  if (toValue && Number.isNaN(toTimestamp)) {
    return {
      ok: false,
      error: 'Please provide a valid "To" date in YYYY-MM-DD format.',
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
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
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
    };
  }

  if (
    !hasProfileQuery &&
    keywords.length === 0 &&
    categoryFeedValue === null
  ) {
    return {
      ok: false,
      error: 'Provide at least one keyword or choose a category feed to fetch headlines.',
      sanitizedSources,
      sanitizedDomains,
      sanitizedExcludeDomains,
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

  return {
    ok: true,
    payload,
    sanitizedSources,
    sanitizedDomains,
    sanitizedExcludeDomains,
  };
}
