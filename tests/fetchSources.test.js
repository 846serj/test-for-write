import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const typeMatch = tsCode.match(/type NewsFreshness[^;]+;/);
const resolveFreshnessMatch = tsCode.match(/function resolveFreshness[\s\S]*?\n\}/);
const mapFreshnessMatch = tsCode.match(/function mapFreshnessToSerpTbs[\s\S]*?\n\}/);
const funcMatch = tsCode.match(/async function fetchSources[\s\S]*?\n\}/);
const normalizePublisherMatch = tsCode.match(/function normalizePublisher[\s\S]*?\n\}/);
const normalizeTitleMatch = tsCode.match(/function normalizeTitleValue[\s\S]*?\n\}/);
const freshnessHoursMatch = tsCode.match(/const FRESHNESS_TO_HOURS[\s\S]*?\n\};/);
const computeFreshnessMatch = tsCode.match(/function computeFreshnessIso[\s\S]*?\n\}/);
const fetchNewsArticlesMatch = tsCode.match(/async function fetchNewsArticles[\s\S]*?\n\}/);
const parseRelativeMatch = tsCode.match(/function parseRelativeTimestamp[\s\S]*?\n\}/);
const parsePublishedMatch = tsCode.match(/function parsePublishedTimestamp[\s\S]*?\n\}/);
const timestampWindowMatch = tsCode.match(/function isTimestampWithinWindow[\s\S]*?\n\}/);
const normalizePublishedMatch = tsCode.match(/function normalizePublishedAt[\s\S]*?\n\}/);
const timeConstantsMatch = tsCode.match(/const MILLIS_IN_MINUTE[\s\S]*?const MAX_FUTURE_DRIFT_MS[^;]*;/);

const snippet = `
${typeMatch[0]}
${freshnessHoursMatch ? freshnessHoursMatch[0] : ''}
${timeConstantsMatch ? timeConstantsMatch[0] : ''}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
${normalizeTitleMatch ? normalizeTitleMatch[0] : ''}
${resolveFreshnessMatch[0]}
${mapFreshnessMatch[0]}
${parseRelativeMatch ? parseRelativeMatch[0] : ''}
${parsePublishedMatch ? parsePublishedMatch[0] : ''}
${timestampWindowMatch ? timestampWindowMatch[0] : ''}
${normalizePublishedMatch ? normalizePublishedMatch[0] : ''}
${funcMatch[0]}
${normalizePublisherMatch ? normalizePublisherMatch[0] : ''}
${computeFreshnessMatch ? computeFreshnessMatch[0] : ''}
${fetchNewsArticlesMatch ? fetchNewsArticlesMatch[0] : ''}
export { fetchSources, serpCalls, setSerpResults, fetchNewsArticles };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { fetchSources, serpCalls, setSerpResults, fetchNewsArticles } = await import(moduleUrl);

const FIXED_NOW_ISO = '2024-03-10T12:00:00Z';
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days, referenceMs = FIXED_NOW_MS) {
  return new Date(referenceMs - days * DAY_MS).toISOString();
}

async function withMockedNow(callback, referenceMs = FIXED_NOW_MS) {
  const originalNow = Date.now;
  Date.now = () => referenceMs;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

test('fetchSources requests google_news with freshness filter and preserves order', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://example.com/newest',
        source: 'Example News',
        title: 'Latest Update',
        snippet: '  Latest summary   here ',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/second',
        source: 'Another Source',
        title: 'Second Story',
        snippet: 'Second summary',
        date: isoDaysAgo(2),
      },
      { link: 'https://example.com/newest', source: 'Example News', date: isoDaysAgo(1) },
      {
        link: 'https://example.com/third',
        source: 'Third Source',
        title: 'Third Story',
        snippet: '',
        date: isoDaysAgo(3),
      },
    ]);
    const sources = await fetchSources('breaking topic', '1h');
    assert.strictEqual(serpCalls.length, 1);
    assert.strictEqual(serpCalls[0].engine, 'google_news');
    assert.strictEqual(serpCalls[0].query, 'breaking topic');
    assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:h');
    assert.strictEqual(serpCalls[0].limit, 8);
    assert.deepStrictEqual(
      sources.map(({ url, summary, publishedAt }) => ({ url, summary, publishedAt })),
      [
        {
          url: 'https://example.com/newest',
          summary: 'Latest summary here',
          publishedAt: isoDaysAgo(1),
        },
        {
          url: 'https://example.com/second',
          summary: 'Second summary',
          publishedAt: isoDaysAgo(2),
        },
        {
          url: 'https://example.com/third',
          summary: '',
          publishedAt: isoDaysAgo(3),
        },
      ]
    );
    assert.strictEqual(sources[0].title, 'Latest Update');
  });
});

test('fetchSources defaults to 6h freshness when none provided', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([{ link: 'https://example.com', date: isoDaysAgo(1) }]);
    await fetchSources('another topic');
    assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:h6');
  });
});

test('fetchSources uses past 7 days filter when requested', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([{ link: 'https://example.com', source: 'Example', date: isoDaysAgo(1) }]);
    await fetchSources('weekly topic', '7d');
    assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:w');
  });
});

test('fetchSources skips results that share the same publisher source', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://example.com/article-a', source: 'Example News', date: isoDaysAgo(1) },
      { link: 'https://example.com/article-b', source: 'Example News', date: isoDaysAgo(2) },
      { link: 'https://different.com/story', source: 'Different Daily', date: isoDaysAgo(3) },
    ]);

    const sources = await fetchSources('duplicate publishers');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://example.com/article-a',
      'https://different.com/story',
    ]);
  });
});

test('fetchSources deduplicates by hostname when source metadata is missing', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://www.host.com/article-1', date: isoDaysAgo(1) },
      { link: 'https://host.com/article-2', date: isoDaysAgo(2) },
      { link: 'https://another.com/story', date: isoDaysAgo(3) },
    ]);

    const sources = await fetchSources('missing sources');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://www.host.com/article-1',
      'https://another.com/story',
    ]);
  });
});

test('fetchSources limits to five unique publishers while preserving order', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://a.com/1', source: 'A', date: isoDaysAgo(1) },
      { link: 'https://b.com/1', source: 'B', date: isoDaysAgo(2) },
      { link: 'https://c.com/1', source: 'C', date: isoDaysAgo(3) },
      { link: 'https://d.com/1', source: 'D', date: isoDaysAgo(4) },
      { link: 'https://e.com/1', source: 'E', date: isoDaysAgo(5) },
      { link: 'https://f.com/1', source: 'F', date: isoDaysAgo(6) },
    ]);

    const sources = await fetchSources('many sources');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://a.com/1',
      'https://b.com/1',
      'https://c.com/1',
      'https://d.com/1',
      'https://e.com/1',
    ]);
  });
});

test('fetchSources skips duplicate headlines even from different publishers', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://unique.com/story',
        source: 'Publisher One',
        title: 'Breaking News Flash',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://duplicate.com/another',
        source: 'Publisher Two',
        title: '  breaking   news   flash  ',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://another.com/story',
        source: 'Publisher Three',
        title: 'Different Headline',
        date: isoDaysAgo(3),
      },
    ]);

    const sources = await fetchSources('duplicate titles');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://unique.com/story',
      'https://another.com/story',
    ]);
  });
});

test('fetchSources dedupes titles that only differ by trailing publisher separators', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://site-a.com/story',
        source: 'Publisher One',
        title: 'AI Breakthrough - The Verge',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://site-b.com/story',
        source: 'Publisher Two',
        title: 'AI Breakthrough | Wired',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://site-c.com/story',
        source: 'Publisher Three',
        title: 'AI Breakthrough — CNN',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://site-d.com/unique',
        source: 'Publisher Four',
        title: 'Different Story - NPR',
        date: isoDaysAgo(4),
      },
    ]);

    const sources = await fetchSources('separator dedupe');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://site-a.com/story',
      'https://site-d.com/unique',
    ]);
  });
});

test('fetchSources drops sources older than the recency window', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://recent.com/story',
        source: 'Recent News',
        title: 'Recent Story',
        date: isoDaysAgo(5),
      },
      {
        link: 'https://old.com/story',
        source: 'Old Archive',
        title: 'Old Story',
        date: isoDaysAgo(20),
      },
    ]);

    const sources = await fetchSources('time filtered');
    assert.deepStrictEqual(sources.map((item) => item.url), ['https://recent.com/story']);
  });
});

test('fetchSources merges NewsAPI and SERP results while deduplicating', async () => {
  await withMockedNow(async () => {
    const originalNewsKey = process.env.NEWS_API_KEY;
    const originalFetch = globalThis.fetch;

    try {
      process.env.NEWS_API_KEY = 'news-key';
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return {
            status: 'ok',
            articles: [
              {
                title: 'AI Launch Announced',
                description: 'Summary from news api',
                url: 'https://example.com/news-ai',
                publishedAt: isoDaysAgo(2),
              },
              {
                title: 'Space Station Update',
                description: 'Space summary',
                url: 'https://space.com/update',
                publishedAt: isoDaysAgo(3),
              },
            ],
          };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: [] });
        },
      });

      serpCalls.length = 0;
      setSerpResults([
        {
          link: 'https://example.com/duplicate',
          source: 'Example News',
          title: 'AI Launch Announced - Example News',
          snippet: 'Duplicate summary',
          date: isoDaysAgo(2),
        },
        {
          link: 'https://different.com/story',
          source: 'Different Daily',
          title: 'Different Angle',
          snippet: 'Different summary',
          date: isoDaysAgo(1),
        },
      ]);

      const sources = await fetchSources('tech space mix', '6h');
      assert.strictEqual(serpCalls.length, 1);
      assert.deepStrictEqual(
        sources.map((item) => item.url),
        [
          'https://example.com/news-ai',
          'https://space.com/update',
          'https://different.com/story',
        ]
      );
      assert.strictEqual(sources[0].summary, 'Summary from news api');
      assert.strictEqual(sources[1].summary, 'Space summary');
    } finally {
      process.env.NEWS_API_KEY = originalNewsKey;
      globalThis.fetch = originalFetch;
    }
  });
});

test('fetchNewsArticles serp fallback dedupes repeated SERP headlines', async () => {
  await withMockedNow(async () => {
    const originalNewsKey = process.env.NEWS_API_KEY;
    const originalSerpKey = process.env.SERPAPI_KEY;
    const originalFetch = globalThis.fetch;

    try {
      process.env.NEWS_API_KEY = '';
      process.env.SERPAPI_KEY = 'test-serp-key';
      globalThis.fetch = async () => {
        throw new Error('fetch should not be called in fallback test');
      };

      serpCalls.length = 0;
      setSerpResults([
        {
          title: 'Market Rally Today',
          link: 'https://site-a.com/story',
          snippet: 'Summary A',
          date: isoDaysAgo(1),
        },
        {
          title: 'market   rally   today',
          link: 'https://site-b.com/story',
          snippet: 'Summary B',
          published_at: isoDaysAgo(1),
        },
        {
          title: 'Different Story',
          link: 'https://site-c.com/story',
          snippet: 'Summary C',
          date: isoDaysAgo(2),
        },
      ]);

      const articles = await fetchNewsArticles('markets', '6h', true);
      assert.strictEqual(articles.length, 2);
      assert.deepStrictEqual(
        articles.map((item) => item.url),
        ['https://site-a.com/story', 'https://site-c.com/story']
      );
    } finally {
      process.env.NEWS_API_KEY = originalNewsKey;
      process.env.SERPAPI_KEY = originalSerpKey;
      globalThis.fetch = originalFetch;
    }
  });
});
