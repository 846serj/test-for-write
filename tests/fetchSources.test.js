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

const snippet = `
${typeMatch[0]}
${freshnessHoursMatch ? freshnessHoursMatch[0] : ''}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
${normalizeTitleMatch ? normalizeTitleMatch[0] : ''}
${resolveFreshnessMatch[0]}
${mapFreshnessMatch[0]}
${funcMatch[0]}
${normalizePublisherMatch ? normalizePublisherMatch[0] : ''}
${computeFreshnessMatch ? computeFreshnessMatch[0] : ''}
${fetchNewsArticlesMatch ? fetchNewsArticlesMatch[0] : ''}
export { fetchSources, serpCalls, setSerpResults, fetchNewsArticles };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { fetchSources, serpCalls, setSerpResults, fetchNewsArticles } = await import(moduleUrl);

test('fetchSources requests google_news with freshness filter and preserves order', async () => {
  serpCalls.length = 0;
  setSerpResults([
    {
      link: 'https://example.com/newest',
      source: 'Example News',
      title: 'Latest Update',
      snippet: '  Latest summary   here ',
      date: '2024-01-01T00:00:00Z',
    },
    {
      link: 'https://example.com/second',
      source: 'Another Source',
      title: 'Second Story',
      snippet: 'Second summary',
    },
    { link: 'https://example.com/newest', source: 'Example News' },
    {
      link: 'https://example.com/third',
      source: 'Third Source',
      title: 'Third Story',
      snippet: '',
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
        publishedAt: '2024-01-01T00:00:00Z',
      },
      {
        url: 'https://example.com/second',
        summary: 'Second summary',
        publishedAt: '',
      },
      {
        url: 'https://example.com/third',
        summary: '',
        publishedAt: '',
      },
    ]
  );
  assert.strictEqual(sources[0].title, 'Latest Update');
});

test('fetchSources defaults to 6h freshness when none provided', async () => {
  serpCalls.length = 0;
  setSerpResults([{ link: 'https://example.com' }]);
  await fetchSources('another topic');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:h6');
});

test('fetchSources uses past 7 days filter when requested', async () => {
  serpCalls.length = 0;
  setSerpResults([{ link: 'https://example.com', source: 'Example' }]);
  await fetchSources('weekly topic', '7d');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:w');
});

test('fetchSources skips results that share the same publisher source', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://example.com/article-a', source: 'Example News' },
    { link: 'https://example.com/article-b', source: 'Example News' },
    { link: 'https://different.com/story', source: 'Different Daily' },
  ]);

  const sources = await fetchSources('duplicate publishers');
  assert.deepStrictEqual(sources.map((item) => item.url), [
    'https://example.com/article-a',
    'https://different.com/story',
  ]);
});

test('fetchSources deduplicates by hostname when source metadata is missing', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://www.host.com/article-1' },
    { link: 'https://host.com/article-2' },
    { link: 'https://another.com/story' },
  ]);

  const sources = await fetchSources('missing sources');
  assert.deepStrictEqual(sources.map((item) => item.url), [
    'https://www.host.com/article-1',
    'https://another.com/story',
  ]);
});

test('fetchSources limits to five unique publishers while preserving order', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://a.com/1', source: 'A' },
    { link: 'https://b.com/1', source: 'B' },
    { link: 'https://c.com/1', source: 'C' },
    { link: 'https://d.com/1', source: 'D' },
    { link: 'https://e.com/1', source: 'E' },
    { link: 'https://f.com/1', source: 'F' },
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

test('fetchSources skips duplicate headlines even from different publishers', async () => {
  serpCalls.length = 0;
  setSerpResults([
    {
      link: 'https://unique.com/story',
      source: 'Publisher One',
      title: 'Breaking News Flash',
    },
    {
      link: 'https://duplicate.com/another',
      source: 'Publisher Two',
      title: '  breaking   news   flash  ',
    },
    {
      link: 'https://another.com/story',
      source: 'Publisher Three',
      title: 'Different Headline',
    },
  ]);

  const sources = await fetchSources('duplicate titles');
  assert.deepStrictEqual(sources.map((item) => item.url), [
    'https://unique.com/story',
    'https://another.com/story',
  ]);
});

test('fetchSources dedupes titles that only differ by trailing publisher separators', async () => {
  serpCalls.length = 0;
  setSerpResults([
    {
      link: 'https://site-a.com/story',
      source: 'Publisher One',
      title: 'AI Breakthrough - The Verge',
    },
    {
      link: 'https://site-b.com/story',
      source: 'Publisher Two',
      title: 'AI Breakthrough | Wired',
    },
    {
      link: 'https://site-c.com/story',
      source: 'Publisher Three',
      title: 'AI Breakthrough — CNN',
    },
    {
      link: 'https://site-d.com/unique',
      source: 'Publisher Four',
      title: 'Different Story - NPR',
    },
  ]);

  const sources = await fetchSources('separator dedupe');
  assert.deepStrictEqual(sources.map((item) => item.url), [
    'https://site-a.com/story',
    'https://site-d.com/unique',
  ]);
});

test('fetchSources merges NewsAPI and SERP results while deduplicating', async () => {
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
              publishedAt: '2024-03-01T00:00:00Z',
            },
            {
              title: 'Space Station Update',
              description: 'Space summary',
              url: 'https://space.com/update',
              publishedAt: '2024-03-02T00:00:00Z',
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
      },
      {
        link: 'https://different.com/story',
        source: 'Different Daily',
        title: 'Different Angle',
        snippet: 'Different summary',
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

test('fetchNewsArticles serp fallback dedupes repeated SERP headlines', async () => {
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
        date: '2024-01-01',
      },
      {
        title: 'market   rally   today',
        link: 'https://site-b.com/story',
        snippet: 'Summary B',
        published_at: '2024-01-01',
      },
      {
        title: 'Different Story',
        link: 'https://site-c.com/story',
        snippet: 'Summary C',
        date: '2024-01-02',
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
