import he from 'he';
import { XMLParser } from 'fast-xml-parser';
import type { TravelPreset } from './travelPresets';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TravelSourceKind = 'rss' | 'api';

export interface TravelSourceDetail {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  categories: string[];
  sourceName: string;
  sourceType: TravelSourceKind;
}

type TravelSourceOptions = {
  travelPreset?: TravelPreset | null;
  state?: string | null;
  fetchImpl?: FetchLike;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
});

function decodeValue(value: unknown): string {
  if (typeof value === 'string') {
    return he.decode(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const decoded = decodeValue(entry);
      if (decoded) {
        return decoded;
      }
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const possible =
      record.rendered ??
      record.value ??
      record['#text'] ??
      record.text ??
      null;
    if (possible !== null) {
      return decodeValue(possible);
    }
  }
  return '';
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: unknown): string {
  const value = decodeValue(raw).trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return '';
}

function extractCategories(raw: unknown): string[] {
  const result: string[] = [];
  const pushValue = (input: unknown) => {
    const decoded = decodeValue(input).trim();
    if (decoded) {
      result.push(decoded);
    }
  };
  if (Array.isArray(raw)) {
    raw.forEach(pushValue);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const keys = ['category', 'categories', 'tags', 'terms', 'topics', 'labels'];
    for (const key of keys) {
      if (key in obj) {
        const value = obj[key];
        if (Array.isArray(value)) {
          value.forEach(pushValue);
        } else if (value && typeof value === 'object') {
          const entries = Object.values(value as Record<string, unknown>);
          entries.forEach(pushValue);
        } else {
          pushValue(value);
        }
      }
    }
  } else {
    pushValue(raw);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const category of result) {
    const key = category.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(category);
    }
  }
  return normalized;
}

function resolvePublishedAt(raw: unknown): string {
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') {
      const decoded = decodeValue(entry);
      if (decoded) {
        return decoded;
      }
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const keys = ['published', 'updated', 'pubDate', 'date', 'modified'];
    for (const key of keys) {
      if (key in obj) {
        const decoded = decodeValue(obj[key]);
        if (decoded) {
          return decoded;
        }
      }
    }
  }
  const fallback = decodeValue(raw);
  return fallback;
}

function normalizeSummary(raw: unknown, fallbackTitle: string): string {
  const decoded = decodeValue(raw);
  const stripped = stripHtml(decoded);
  if (stripped) {
    return stripped;
  }
  return fallbackTitle;
}

function normalizeRssItem(
  item: Record<string, unknown>,
  channelTitle: string
): TravelSourceDetail | null {
  const title = decodeValue(item.title).trim() || 'Untitled';
  const link = normalizeUrl(item.link ?? item.guid ?? item.url);
  if (!link) {
    return null;
  }
  const summarySource =
    item['content:encoded'] ??
    item['content'] ??
    item.description ??
    item.summary ??
    item.excerpt ??
    item.subtitle;
  const publishedAt = resolvePublishedAt([
    item.pubDate,
    item.published,
    item.updated,
    item['dc:date'],
    item.date,
  ]);
  const categories = extractCategories(
    item.category ?? item.categories ?? item.tags ?? item.keyword
  );
  return {
    title,
    url: link,
    summary: normalizeSummary(summarySource, title),
    publishedAt,
    categories,
    sourceName: channelTitle || 'RSS Feed',
    sourceType: 'rss',
  };
}

async function fetchRssFeed(
  feedUrl: string,
  fetchImpl: FetchLike
): Promise<TravelSourceDetail[]> {
  try {
    const response = await fetchImpl(feedUrl, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }
    const text = await response.text();
    if (!text.trim()) {
      return [];
    }
    const parsed = parser.parse(text);
    const channel =
      parsed?.rss?.channel ?? parsed?.feed ?? parsed?.channel ?? parsed?.RSS?.channel;
    if (!channel) {
      return [];
    }
    const channelTitle = decodeValue(channel.title).trim();
    const itemsRaw = channel.item ?? channel.items ?? channel.entry ?? [];
    const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];
    const results: TravelSourceDetail[] = [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      const normalized = normalizeRssItem(
        rawItem as Record<string, unknown>,
        channelTitle
      );
      if (normalized) {
        results.push(normalized);
      }
    }
    return results;
  } catch {
    return [];
  }
}

function extractJsonArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === 'object') as Record<
      string,
      unknown
    >[];
  }
  if (data && typeof data === 'object') {
    const values = Object.values(data as Record<string, unknown>);
    const firstArray = values.find((value) => Array.isArray(value));
    if (Array.isArray(firstArray)) {
      return firstArray.filter((item) => item && typeof item === 'object') as Record<
        string,
        unknown
      >[];
    }
  }
  return [];
}

function normalizeTravelOregonItem(
  item: Record<string, unknown>,
  sourceName: string,
  fallbackCategory: string
): TravelSourceDetail | null {
  const title = decodeValue(item.title).trim() || 'Untitled';
  const link = normalizeUrl(item.link ?? item.url);
  if (!link) {
    return null;
  }
  const summarySource = item.excerpt ?? item.description ?? item.summary ?? item.content;
  const publishedAt = resolvePublishedAt([
    item.date,
    item.published,
    item.modified,
    item.updated,
  ]);
  const categoriesRaw =
    item.event_categories ?? item.categories ?? item.terms ?? item.tags ?? fallbackCategory;
  const categories = extractCategories(categoriesRaw);
  if (!categories.length && fallbackCategory) {
    categories.push(fallbackCategory);
  }
  return {
    title,
    url: link,
    summary: normalizeSummary(summarySource, title),
    publishedAt,
    categories,
    sourceName,
    sourceType: 'api',
  };
}

async function fetchTravelOregonCollections(
  fetchImpl: FetchLike
): Promise<TravelSourceDetail[]> {
  const endpoints: { url: string; sourceName: string; fallbackCategory: string }[] = [
    {
      url: 'https://traveloregon.com/wp-json/wp/v2/event?per_page=25&_fields=title,link,excerpt,date,event_categories',
      sourceName: 'Travel Oregon Events',
      fallbackCategory: 'Events',
    },
    {
      url: 'https://traveloregon.com/wp-json/wp/v2/lodging?per_page=25&_fields=title,link,excerpt,date,categories',
      sourceName: 'Travel Oregon Lodging',
      fallbackCategory: 'Lodging',
    },
  ];
  const aggregated: TravelSourceDetail[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetchImpl(endpoint.url, { cache: 'no-store' });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      const collection = extractJsonArray(data);
      for (const item of collection) {
        const normalized = normalizeTravelOregonItem(
          item,
          endpoint.sourceName,
          endpoint.fallbackCategory
        );
        if (normalized) {
          aggregated.push(normalized);
        }
      }
    } catch {
      continue;
    }
  }
  return aggregated;
}

export async function fetchTravelPresetSources({
  travelPreset,
  state,
  fetchImpl = fetch,
}: TravelSourceOptions): Promise<TravelSourceDetail[]> {
  const presetState = (travelPreset?.state ?? '').trim().toLowerCase();
  const normalizedState = (state ?? presetState).trim().toLowerCase();
  const feeds = Array.isArray(travelPreset?.rssFeeds)
    ? (travelPreset!.rssFeeds.filter((url) => typeof url === 'string') as string[])
    : [];

  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  const results: TravelSourceDetail[] = [];
  const seenUrls = new Set<string>();
  const seenFeedUrls = new Set<string>();

  for (const feedUrl of feeds) {
    const normalizedUrl = normalizeUrl(feedUrl);
    if (!normalizedUrl) {
      continue;
    }
    if (seenFeedUrls.has(normalizedUrl)) {
      continue;
    }
    seenFeedUrls.add(normalizedUrl);
    const entries = await fetchRssFeed(normalizedUrl, fetcher);
    for (const entry of entries) {
      if (seenUrls.has(entry.url)) {
        continue;
      }
      seenUrls.add(entry.url);
      results.push(entry);
    }
  }

  if (normalizedState === 'or' || presetState === 'or') {
    const oregonEntries = await fetchTravelOregonCollections(fetcher);
    for (const entry of oregonEntries) {
      if (seenUrls.has(entry.url)) {
        continue;
      }
      seenUrls.add(entry.url);
      results.push(entry);
    }
  }

  return results;
}
