import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

function extract(regex, description) {
  const match = tsCode.match(regex);
  if (!match) {
    throw new Error(`Failed to extract ${description}`);
  }
  return match[0];
}

const snippet = `
${extract(/const MILLIS_IN_MINUTE[\s\S]*?const MAX_FUTURE_DRIFT_MS[^;]*;/, 'time constants')}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
const travelPresetStubMap = new Map();
function setTravelPresetStub(state, preset) {
  const key = typeof state === 'string' && state.trim() ? state.trim().toLowerCase() : '';
  travelPresetStubMap.set(key, preset);
}
function clearTravelPresetStubs() {
  travelPresetStubMap.clear();
}
async function getTravelPreset(state) {
  const key = typeof state === 'string' && state.trim() ? state.trim().toLowerCase() : '';
  if (travelPresetStubMap.has(key)) {
    return travelPresetStubMap.get(key);
  }
  const label = key ? key.toUpperCase() : 'the destination';
  return {
    state: key,
    stateName: label,
    keywords: [],
    rssFeeds: [],
    instructions: [
      \`Spotlight must-see attractions, parks, and outdoor experiences throughout \${label}.\`,
      \`Blend lodging and dining recommendations tailored to different traveler budgets in \${label}.\`,
      \`Share itinerary-friendly tips—seasonal timing, route suggestions, and pacing guidance—for exploring \${label}.\`,
    ],
    siteKey: null,
  };
}
function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
${extract(/function normalizeTitleValue[\s\S]*?\n\}/, 'normalizeTitleValue')}
${extract(/function parseRelativeTimestamp[\s\S]*?\n\}/, 'parseRelativeTimestamp')}
${extract(/function parsePublishedTimestamp[\s\S]*?\n\}/, 'parsePublishedTimestamp')}
${extract(/function isTimestampWithinWindow[\s\S]*?\n\}/, 'isTimestampWithinWindow')}
${extract(/function normalizePublishedAt[\s\S]*?\n\}/, 'normalizePublishedAt')}
${extract(/const SOURCE_TOKEN_MIN_LENGTH[\s\S]*?return \(2 \* precision \* recall\)[\s\S]*?\n\}/, 'source token helpers')}
${extract(/type ScoredReportingSource[\s\S]*?;/, 'ScoredReportingSource type')}
${extract(/async function fetchSources[\s\S]*?\n\}/, 'fetchSources')}
${extract(/function normalizeHrefValue[\s\S]*?\n\}/, 'normalizeHrefValue')}
${extract(/function buildUrlVariants[\s\S]*?\n\}/, 'buildUrlVariants')}
${extract(/function normalizePublisher[\s\S]*?\n\}/, 'normalizePublisher')}
${extract(/const TRAVEL_KEYWORDS[\s\S]*?function buildTravelInstructionBlock[\s\S]*?\n\}/, 'travel keyword helpers')}
${extract(/async function fetchEvergreenTravelSources[\s\S]*?\n\}/, 'fetchEvergreenTravelSources')}
${extract(/function mergeEvergreenTravelSources[\s\S]*?\n\}/, 'mergeEvergreenTravelSources')}
${extract(/async function fetchNewsArticles[\s\S]*?\n\}/, 'fetchNewsArticles')}
${extract(/function formatKeyDetails[\s\S]*?\n\}/, 'formatKeyDetails')}
${extract(/function normalizeSummary[\s\S]*?\n\}/, 'normalizeSummary')}
${extract(/function formatPublishedTimestamp[\s\S]*?\n\}/, 'formatPublishedTimestamp')}
${extract(/function extractStructuredFacts[\s\S]*?\n\}/, 'extractStructuredFacts')}
${extract(/function buildRecentReportingBlock[\s\S]*?\n\}/, 'buildRecentReportingBlock')}
export {
  fetchSources,
  serpCalls,
  setSerpResults,
  fetchNewsArticles,
  fetchEvergreenTravelSources,
  mergeEvergreenTravelSources,
  buildRecentReportingBlock,
  setTravelPresetStub,
  clearTravelPresetStubs,
};
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const {
  fetchSources,
  serpCalls,
  setSerpResults,
  fetchNewsArticles,
  fetchEvergreenTravelSources,
  mergeEvergreenTravelSources,
  buildRecentReportingBlock,
  setTravelPresetStub,
  clearTravelPresetStubs,
} = await import(moduleUrl);

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

test('fetchSources requests google_news with relevance sort and ranks by score', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://example.com/success',
        source: 'Example News',
        title: 'SpaceX rocket launch succeeds in reaching orbit',
        snippet: '  SpaceX rocket launch succeeds with crew mission  ',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/sports',
        source: 'Local Sports',
        title: 'High school football finals',
        snippet: 'Local sports update',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/delays',
        source: 'Space Daily',
        title: 'SpaceX delays new rocket launch',
        snippet: 'Weather postpones SpaceX rocket launch schedule',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://example.com/analysis',
        source: 'Orbital Times',
        title: 'Rocket launch schedule update',
        snippet: 'SpaceX outlines launch timeline after success',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://example.com/overview',
        source: 'Industry Watch',
        title: 'Space industry overview',
        snippet: 'Space industry overview',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/markets',
        source: 'Economy Daily',
        title: 'Global markets rebound',
        snippet: 'Markets update',
        date: isoDaysAgo(2),
      },
    ]);
    const sources = await fetchSources('SpaceX rocket launch succeeds', {
      maxAgeMs: null,
      serpParams: { sort_by: 'relevance' },
    });
    assert.strictEqual(serpCalls.length, 1);
    assert.strictEqual(serpCalls[0].engine, 'google_news');
    assert.strictEqual(serpCalls[0].query, 'SpaceX rocket launch succeeds');
    assert.deepStrictEqual(serpCalls[0].extraParams, { sort_by: 'relevance' });
    assert.strictEqual(serpCalls[0].limit, 12);
    assert.deepStrictEqual(
      sources.map(({ url, summary, publishedAt }) => ({ url, summary, publishedAt })),
      [
        {
          url: 'https://example.com/success',
          summary: 'SpaceX rocket launch succeeds with crew mission',
          publishedAt: isoDaysAgo(1),
        },
        {
          url: 'https://example.com/delays',
          summary: 'Weather postpones SpaceX rocket launch schedule',
          publishedAt: isoDaysAgo(2),
        },
        {
          url: 'https://example.com/analysis',
          summary: 'SpaceX outlines launch timeline after success',
          publishedAt: isoDaysAgo(3),
        },
      ]
    );
    assert.deepStrictEqual(
      sources.map(({ title }) => title),
      [
        'SpaceX rocket launch succeeds in reaching orbit',
        'SpaceX delays new rocket launch',
        'Rocket launch schedule update',
      ]
    );
  });
});

test('fetchSources filters out irrelevant stories and keeps the highest scoring ones', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://news.com/leaders',
        source: 'World News',
        title: 'Global climate policy leaders meet',
        snippet: 'Global climate policy meeting draws leaders to summit',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://news.com/emissions',
        source: 'Climate Desk',
        title: 'Climate meeting focuses on global emissions',
        snippet: 'Policy experts discuss global climate goals at meeting',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://news.com/debate',
        source: 'Policy Times',
        title: 'Policy debate on climate goals',
        snippet: 'Global climate policy debate highlights meeting agenda',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://news.com/finance',
        source: 'Finance Daily',
        title: 'Climate finance talks continue',
        snippet: 'Global climate policy finance meeting continues talks',
        date: isoDaysAgo(4),
      },
      {
        link: 'https://news.com/agenda',
        source: 'Agenda Watch',
        title: 'Global meeting agenda set',
        snippet: 'Policy meeting agenda set for global climate leaders',
        date: isoDaysAgo(5),
      },
      {
        link: 'https://news.com/plan',
        source: 'Planning Desk',
        title: 'Meeting plan finalized',
        snippet: 'Plan finalized ahead of meeting',
        date: isoDaysAgo(6),
      },
      {
        link: 'https://news.com/sports',
        source: 'Local Sports',
        title: 'Local sports update',
        snippet: 'High school team wins championship',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://news.com/tech',
        source: 'Tech Wire',
        title: 'Tech company releases new phone',
        snippet: 'Latest smartphone launch details',
        date: isoDaysAgo(2),
      },
    ]);

    const sources = await fetchSources('Global climate policy meeting');

    assert.strictEqual(sources.length, 5);
    assert.deepStrictEqual(
      sources.map(({ url }) => url),
      [
        'https://news.com/leaders',
        'https://news.com/debate',
        'https://news.com/finance',
        'https://news.com/agenda',
        'https://news.com/emissions',
      ]
    );
    assert.ok(
      sources.every((item) =>
        item.summary.toLowerCase().includes('climate') ||
        item.summary.toLowerCase().includes('policy') ||
        item.summary.toLowerCase().includes('meeting')
      )
    );
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
        snippet: 'Breaking news flash update details',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://duplicate.com/another',
        source: 'Publisher Two',
        title: '  breaking   news   flash  ',
        snippet: 'Breaking news flash update coverage',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://another.com/story',
        source: 'Publisher Three',
        title: 'Different Headline',
        snippet: 'Different headline covering breaking news update',
        date: isoDaysAgo(3),
      },
    ]);

    const sources = await fetchSources('breaking news flash update');
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
        snippet: 'AI breakthrough report details from Verge',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://site-b.com/story',
        source: 'Publisher Two',
        title: 'AI Breakthrough | Wired',
        snippet: 'AI breakthrough report from Wired magazine',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://site-c.com/story',
        source: 'Publisher Three',
        title: 'AI Breakthrough — CNN',
        snippet: 'AI breakthrough report covered by CNN',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://site-d.com/unique',
        source: 'Publisher Four',
        title: 'Different Story - NPR',
        snippet: 'Different AI breakthrough report with unique details',
        date: isoDaysAgo(4),
      },
    ]);

    const sources = await fetchSources('ai breakthrough report');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://site-a.com/story',
      'https://site-d.com/unique',
    ]);
  });
});

test('fetchEvergreenTravelSources queries general search for travel-focused guidance', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    clearTravelPresetStubs();
    setTravelPresetStub('or', {
      state: 'or',
      stateName: 'Oregon',
      keywords: [
        'Oregon travel itinerary',
        'Oregon coast weekend itinerary',
      ],
      rssFeeds: ['https://traveloregon.com/feed'],
      instructions: ['Highlight scenic Oregon road trips.'],
      siteKey: 'oregonAdventure',
    });
    setSerpResults([
      {
        link: 'https://travel.com/kyoto',
        title: 'Kyoto Travel Guide',
        summary: 'Complete travel guide with things to do in Kyoto',
        date: isoDaysAgo(40),
      },
      {
        link: 'https://travel.com/kyoto-itinerary',
        title: 'Kyoto attractions and itinerary tips',
        snippet: 'Top attractions to visit with a family-friendly itinerary',
        date: isoDaysAgo(55),
      },
      {
        link: 'https://travel.com/kyoto',
        title: 'Duplicate Kyoto travel guide',
        snippet: 'Travel tips and places to visit in Kyoto',
        date: isoDaysAgo(30),
      },
      {
        link: 'https://weather.com/kyoto',
        title: 'Kyoto weather update',
        snippet: 'Weekly forecast and precipitation outlook',
        date: isoDaysAgo(2),
      },
    ]);

    const sources = await fetchEvergreenTravelSources(
      'Kyoto cherry blossoms',
      { travelState: 'or' }
    );

    assert.strictEqual(serpCalls.length, 1);
    assert.strictEqual(serpCalls[0].engine, 'google');
    assert.strictEqual(
      serpCalls[0].query,
      'Kyoto cherry blossoms Oregon Oregon travel Oregon itinerary Oregon weekend travel guide'
    );
    assert.deepStrictEqual(serpCalls[0].extraParams, { hl: 'en' });
    assert.deepStrictEqual(
      sources.map(({ url, publishedAt }) => ({ url, publishedAt })),
      [
        { url: 'https://travel.com/kyoto', publishedAt: isoDaysAgo(40) },
        {
          url: 'https://travel.com/kyoto-itinerary',
          publishedAt: isoDaysAgo(55),
        },
      ]
    );
    assert.deepStrictEqual(
      sources.map(({ summary }) => summary),
      [
        'Complete travel guide with things to do in Kyoto',
        'Top attractions to visit with a family-friendly itinerary',
      ]
    );
  });
});

test('fetchEvergreenTravelSources merges preset keywords without duplicating search terms', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    clearTravelPresetStubs();
    setTravelPresetStub('ca', {
      state: 'ca',
      stateName: 'California',
      keywords: ['California travel', 'Weekend getaway', 'Travel Guide'],
      rssFeeds: [],
      instructions: ['Cover iconic California park itineraries.'],
      siteKey: 'californiaAdventure',
    });
    setSerpResults([
      {
        link: 'https://travel.com/yosemite-weekend',
        title: 'Yosemite weekend getaway ideas',
        snippet: 'Weekend getaway plans for California adventurers',
        date: isoDaysAgo(120),
      },
      {
        link: 'https://news.com/policy',
        title: 'California tax policy update',
        snippet: 'Policy news unrelated to legislation changes',
        date: isoDaysAgo(5),
      },
    ]);

    const sources = await fetchEvergreenTravelSources('Yosemite adventures', {
      travelState: 'ca',
    });

    assert.strictEqual(serpCalls.length, 1);
    assert.strictEqual(
      serpCalls[0].query,
      'Yosemite adventures California California travel California itinerary California weekend travel guide'
    );
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://travel.com/yosemite-weekend',
    ]);
  });
});

test('mergeEvergreenTravelSources dedupes, caps extras, and feeds reporting block', () => {
  const reportingSources = [
    {
      title: 'Recent Kyoto news',
      url: 'https://news.com/kyoto-update',
      summary: 'Recent developments in Kyoto tourism board announcements',
      publishedAt: isoDaysAgo(5),
    },
    {
      title: 'Kyoto hotel openings',
      url: 'https://news.com/kyoto-hotels',
      summary: 'New hotel openings expand travel capacity',
      publishedAt: isoDaysAgo(4),
    },
  ];

  const evergreenSources = [
    {
      title: 'Kyoto trip planner',
      url: 'https://travel.com/plan',
      summary: 'Trip planner with things to do and where to stay',
      publishedAt: '',
    },
    {
      title: 'Kyoto trip planner duplicate',
      url: 'https://travel.com/plan/',
      summary: 'Duplicate entry that should be skipped',
      publishedAt: '',
    },
    {
      title: 'Top Kyoto temples',
      url: 'https://travel.com/temples',
      summary: 'Guide to visiting the top temples in Kyoto',
      publishedAt: '',
    },
    {
      title: 'Kyoto dining guide',
      url: 'https://travel.com/dining',
      summary: 'Restaurants to visit in Kyoto',
      publishedAt: '',
    },
    {
      title: 'Recent news duplicate',
      url: 'https://news.com/kyoto-update',
      summary: 'Should be ignored because it matches recent source',
      publishedAt: '',
    },
    {
      title: 'Extra Kyoto hikes',
      url: 'https://travel.com/hikes',
      summary: 'Hiking routes around Kyoto',
      publishedAt: '',
    },
  ];

  const merged = mergeEvergreenTravelSources(reportingSources, evergreenSources);

  assert.strictEqual(merged.length, reportingSources.length + 3);
  assert.deepStrictEqual(
    merged.slice(reportingSources.length).map((item) => item.url),
    [
      'https://travel.com/plan',
      'https://travel.com/temples',
      'https://travel.com/dining',
    ]
  );

  assert.deepStrictEqual(
    merged.slice(0, reportingSources.length).map((item) => item.url),
    reportingSources.map((item) => item.url)
  );
  assert.ok(!merged.some((item) => item.url === 'https://travel.com/plan/'));
  assert.ok(!merged.some((item) => item.url === 'https://travel.com/hikes'));
});

test('fetchSources keeps older sources when recency is disabled', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://recent.com/story',
        source: 'Recent News',
        title: 'Recent Story',
        snippet: 'Recent story update on policy',
        date: isoDaysAgo(5),
      },
      {
        link: 'https://old.com/story',
        source: 'Old Archive',
        title: 'Old Story',
        snippet: 'Old story update on policy history',
        date: isoDaysAgo(45),
      },
    ]);

    const sources = await fetchSources('policy story update', {
      maxAgeMs: null,
      serpParams: { sort_by: 'relevance' },
    });
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://recent.com/story',
      'https://old.com/story',
    ]);
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
                description: 'Launch space update summary',
                url: 'https://example.com/news-ai',
                publishedAt: isoDaysAgo(2),
              },
              {
                title: 'Space Station Update',
                description: 'Space update summary',
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
          snippet: 'AI launch duplicate summary',
          date: isoDaysAgo(2),
        },
        {
          link: 'https://different.com/story',
          source: 'Different Daily',
          title: 'Different Angle',
          snippet: 'Different space update angle',
          date: isoDaysAgo(1),
        },
      ]);

      const sources = await fetchSources('ai launch space update');
      assert.strictEqual(serpCalls.length, 1);
      assert.strictEqual(sources.length, 3);
      assert.strictEqual(sources[0].url, 'https://example.com/news-ai');
      assert.strictEqual(sources[0].summary, 'Launch space update summary');
      assert.deepStrictEqual(
        sources
          .slice(1)
          .map(({ url }) => url)
          .sort(),
        ['https://different.com/story', 'https://space.com/update'].sort()
      );
      const spaceSource = sources.find(
        (item) => item.url === 'https://space.com/update'
      );
      assert.ok(spaceSource);
      assert.strictEqual(spaceSource.summary, 'Space update summary');
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

      const articles = await fetchNewsArticles('markets', true);
      assert.strictEqual(articles.length, 2);
      assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:d14');
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
