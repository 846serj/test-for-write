const PREFETCH_TTL_MS = 5 * 60 * 1000; // 5 minutes

type PrefetchKind = 'blog' | 'transcript';

type CacheEntry = {
  data: string;
  expiresAt: number;
};

const globalObj = globalThis as {
  __prefetchCache__?: Map<string, CacheEntry>;
};

if (!globalObj.__prefetchCache__) {
  globalObj.__prefetchCache__ = new Map();
}

const cache = globalObj.__prefetchCache__!;

const buildKey = (kind: PrefetchKind, url: string) =>
  `${kind}:${url.trim()}`;

function pruneExpired(key: string, entry: CacheEntry | undefined) {
  if (entry && entry.expiresAt < Date.now()) {
    cache.delete(key);
    return true;
  }
  return false;
}

export function getPrefetchedContent(
  kind: PrefetchKind,
  url: string
): string | null {
  if (!url) {
    return null;
  }
  const key = buildKey(kind, url);
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (pruneExpired(key, entry)) {
    return null;
  }
  return entry.data;
}

export function setPrefetchedContent(
  kind: PrefetchKind,
  url: string,
  data: string
): void {
  if (!url || !data) {
    return;
  }
  const key = buildKey(kind, url);
  cache.set(key, {
    data,
    expiresAt: Date.now() + PREFETCH_TTL_MS,
  });
}

export function clearPrefetchedContent(kind: PrefetchKind, url: string): void {
  if (!url) {
    return;
  }
  cache.delete(buildKey(kind, url));
}
