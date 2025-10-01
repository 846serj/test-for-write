import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { beforeEach, test } from 'node:test';

const routePath = new URL('../src/app/api/headlines/route.ts', import.meta.url);
const categoryConfigPath = new URL('../src/constants/categoryFeeds.ts', import.meta.url);
const tsSource = fs.readFileSync(routePath, 'utf8');
const categorySource = fs.readFileSync(categoryConfigPath, 'utf8');

const sanitizedSource = tsSource
  .replace("import { NextRequest, NextResponse } from 'next/server';", '')
  .replace("import { XMLParser } from 'fast-xml-parser';", '')
  .replace("import { getOpenAI } from '../../../lib/openai';", '')
  .replace(
    "import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';",
    ''
  )
  .replace(
    "import {\n  CATEGORY_FEED_SET,\n  type CategoryFeedValue,\n} from '../../../constants/categoryFeeds';\n",
    ''
  );

const snippet = `
${categorySource}
const NextResponse = globalThis.__nextResponse;
const getOpenAI = () => globalThis.__openai;
const fetch = globalThis.__fetch;
const serpapiSearch = (...args) => globalThis.__serpapiSearch(...args);
const { XMLParser } = globalThis.__fastXmlParser;
type SerpApiResult = any;
type NextRequest = any;
${sanitizedSource}
export { createHeadlinesHandler };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const nextResponseStub = {
  json(body, init) {
    return {
      body,
      status: init?.status ?? 200,
      async json() {
        return body;
      },
    };
  },
};

globalThis.__nextResponse = nextResponseStub;

globalThis.__fetchImpl = async () => {
  throw new Error('fetch not stubbed');
};

globalThis.__fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__serpapiSearch = async () => {
  throw new Error('serpapi not stubbed');
};

globalThis.__openaiCreate = async () => {
  throw new Error('openai not stubbed');
};

globalThis.__openai = {
  chat: {
    completions: {
      create: (...args) => globalThis.__openaiCreate(...args),
    },
  },
};

const fastXmlParserModule = await import('fast-xml-parser');
globalThis.__fastXmlParser = fastXmlParserModule;

const { createHeadlinesHandler } = await import(moduleUrl);

function createRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

beforeEach(() => {
  process.env.NEWSAPI_API_KEY = 'test-key';
  globalThis.__fetchImpl = async () => {
    throw new Error('fetch not stubbed');
  };
  globalThis.__openaiCreate = async () => {
    throw new Error('openai not stubbed');
  };
  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi not stubbed');
  };
});

test('rejects requests without query or keywords', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };
  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(createRequest({ limit: 5 }));
  assert.strictEqual(response.status, 400);
  const body = await response.json();
  assert.strictEqual(
    body.error,
    'Either query, keywords, or description must be provided'
  );
});

test('category requests permit requesting up to 100 headlines', async () => {
  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    fetchCalls.push({
      pageSize: Number(url.searchParams.get('pageSize')),
      page: Number(url.searchParams.get('page')),
    });

    return {
      ok: true,
      headers: {
        get() {
          return 'application/json';
        },
      },
      async json() {
        return { status: 'ok', articles: [] };
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ category: 'business', country: 'us', limit: 100 })
  );

  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(fetchCalls, [{ pageSize: 100, page: 1 }]);
});

test('infers keywords when only a description is provided', async () => {
  const openaiCalls = [];
  globalThis.__openaiCreate = async (options) => {
    openaiCalls.push(options);
    return {
      choices: [
        {
          message: {
            content: '{}',
          },
        },
      ],
    };
  };

  const fetchCalls = [];
  const keywordQuery =
    'Focus AND technology AND driven AND robotics AND transforming';
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    fetchCalls.push({
      query: url.searchParams.get('q') || '',
      pageSize: Number(url.searchParams.get('pageSize')),
      page: Number(url.searchParams.get('page')),
    });

    const articles = [
      {
        title: 'AI robotics breakthrough',
        description: 'desc1',
        url: 'https://example.com/1',
        source: { name: 'Source A' },
        publishedAt: '2024-03-01T00:00:00Z',
      },
      {
        title: 'Healthcare automation',
        description: 'desc2',
        url: 'https://example.com/2',
        source: { name: 'Source B' },
        publishedAt: '2024-03-02T00:00:00Z',
      },
      {
        title: 'Robot nurses on the rise',
        description: 'desc3',
        url: 'https://example.com/3',
        source: { name: 'Source C' },
        publishedAt: '2024-03-03T00:00:00Z',
      },
    ];

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const description =
    'Focus on technology-driven AI robotics transforming hospital care.';
  const response = await handler(createRequest({ description, limit: 3 }));

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.strictEqual(openaiCalls.length, 1);
  assert.ok(openaiCalls[0].messages?.[1]?.content.includes(description));
  assert.deepStrictEqual(body.inferredKeywords, [
    'Focus',
    'technology',
    'driven',
    'robotics',
    'transforming',
  ]);
  assert.deepStrictEqual(body.inferredCategories, ['technology']);
  assert.deepStrictEqual(body.queriesAttempted, [
    keywordQuery,
    'Focus',
    'technology',
    'driven',
    'robotics',
    'transforming',
  ]);
  assert.deepStrictEqual(fetchCalls, [
    { query: keywordQuery, pageSize: 3, page: 1 },
    { query: 'Focus', pageSize: 3, page: 1 },
    { query: 'technology', pageSize: 3, page: 1 },
    { query: 'driven', pageSize: 3, page: 1 },
    { query: 'robotics', pageSize: 3, page: 1 },
    { query: 'transforming', pageSize: 3, page: 1 },
  ]);
  assert.strictEqual(body.successfulQueries, 6);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
});

test('combines rss feeds with NewsAPI results', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const rssUrlOne = 'https://example.com/feed-one';
  const rssUrlTwo = 'https://example.com/feed-two';
  const rssXmlOne = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed One</title>
    <item>
      <title>RSS One</title>
      <link>https://example.com/story-one</link>
      <description>RSS description one</description>
      <pubDate>Fri, 05 Jul 2024 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
  const rssXmlTwo = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed Two</title>
    <item>
      <title>RSS Two</title>
      <link>https://example.com/story-two</link>
      <description>RSS description two</description>
      <pubDate>Thu, 04 Jul 2024 15:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  const newsArticles = [
    {
      title: 'NewsAPI Headline One',
      description: 'News description one',
      url: 'https://news.example.com/story-one',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-30T08:00:00Z',
    },
    {
      title: 'NewsAPI Headline Two',
      description: 'News description two',
      url: 'https://news.example.com/story-two',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-29T08:00:00Z',
    },
    {
      title: 'NewsAPI Headline Three',
      description: 'News description three',
      url: 'https://news.example.com/story-three',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-28T08:00:00Z',
    },
  ];

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith('https://newsapi.org')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles: newsArticles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: newsArticles });
        },
      };
    }

    if (url === rssUrlOne) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXmlOne;
        },
      };
    }

    if (url === rssUrlTwo) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXmlTwo;
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => [];

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'space exploration',
      limit: 3,
      rssFeeds: [rssUrlOne, rssUrlTwo],
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.strictEqual(body.headlines.length, 3);
  const titles = new Set(body.headlines.map((item) => item.title));
  assert.ok(titles.has('RSS One'));
  assert.ok(titles.has('RSS Two'));
  assert.ok(titles.has('NewsAPI Headline One'));

  const rssOne = body.headlines.find((item) => item.title === 'RSS One');
  assert.ok(rssOne);
  assert.strictEqual(rssOne.source, 'Example Feed One');

  const rssTwo = body.headlines.find((item) => item.title === 'RSS Two');
  assert.ok(rssTwo);
  assert.strictEqual(rssTwo.source, 'Example Feed Two');

  assert.ok(
    body.queriesAttempted.some(
      (entry) =>
        entry === 'space exploration' || entry === '"space exploration"'
    )
  );
  assert.ok(
    body.queriesAttempted.some((entry) => entry.includes('RSS: Example Feed One'))
  );
  assert.ok(
    body.queriesAttempted.some((entry) => entry.includes('RSS: Example Feed Two'))
  );

  assert.strictEqual(body.successfulQueries, 3);
});

test('later keyword searches contribute unique headlines', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const manualQuery = 'deep space';
  const combinedKeywords = 'Mars AND Jupiter';
  const responses = new Map([
    [
      `${manualQuery}|1`,
      [
        {
          title: 'Deep space telescope update',
          description: 'Old update from telescope',
          url: 'https://example.com/deep-space-1',
          source: { name: 'Legacy Source' },
          publishedAt: '2024-06-01T00:00:00Z',
        },
        {
          title: 'Deep space mission plans',
          description: 'Older mission plans',
          url: 'https://example.com/deep-space-2',
          source: { name: 'Legacy Source' },
          publishedAt: '2024-06-02T00:00:00Z',
        },
      ],
    ],
    [
      `${combinedKeywords}|1`,
      [
        {
          title: 'Mars and Jupiter alignment',
          description: 'Older planetary alignment news',
          url: 'https://example.com/alignment',
          source: { name: 'Planet News' },
          publishedAt: '2024-06-03T00:00:00Z',
        },
        {
          title: 'Joint Mars-Jupiter study',
          description: 'Another older study',
          url: 'https://example.com/study',
          source: { name: 'Planet News' },
          publishedAt: '2024-06-04T00:00:00Z',
        },
      ],
    ],
    [
      'Mars|1',
      [
        {
          title: 'Fresh Mars rover discovery',
          description: 'Brand new rover discovery',
          url: 'https://example.com/mars-rover',
          source: { name: 'Modern Science' },
          publishedAt: '2024-07-05T09:00:00Z',
        },
      ],
    ],
    [
      'Jupiter|1',
      [
        {
          title: 'New Jupiter storm observed',
          description: 'Recent observation from probe',
          url: 'https://example.com/jupiter-storm',
          source: { name: 'Modern Science' },
          publishedAt: '2024-07-04T10:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: manualQuery,
      keywords: ['Mars', 'Jupiter'],
      limit: 4,
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.ok(
    body.headlines.some((item) => item.url === 'https://example.com/mars-rover')
  );
  assert.ok(
    body.headlines.some(
      (item) => item.url === 'https://example.com/jupiter-storm'
    )
  );

  assert.ok(
    body.queriesAttempted.includes('Mars') &&
      body.queriesAttempted.includes('Jupiter')
  );

  const marsCalls = fetchCalls.filter((entry) => entry.query === 'Mars');
  const jupiterCalls = fetchCalls.filter((entry) => entry.query === 'Jupiter');
  assert.ok(marsCalls.length >= 1);
  assert.ok(jupiterCalls.length >= 1);

  assert.ok(body.successfulQueries >= 3);
});

test('aggregates deduplicated results for derived keyword query', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const keywordQuery = 'AI AND Robotics AND healthcare';
  const responses = new Map([
    [
      `${keywordQuery}|1`,
      [
        {
          title: 'Robotic surgeons',
          description: 'Robotic surgeons assist in operations',
          url: 'https://example.com/1',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'AI in hospitals',
          description: 'Hospitals adopt AI for patient care',
          url: 'https://example.com/2',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
        {
          title: 'Duplicate entry',
          description: 'Duplicate entry for deduplication test',
          url: 'https://example.com/1',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
      ],
    ],
    [
      `${keywordQuery}|2`,
      [
        {
          title: 'Care robots expand',
          description: 'Care robots enter more clinics',
          url: 'https://example.com/3',
          source: { name: 'Source C' },
          publishedAt: '2024-01-03T00:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ keywords: ['AI ', 'Robotics', 'healthcare'], limit: 3 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, [
    keywordQuery,
    'AI',
    'Robotics',
    'healthcare',
  ]);
  assert.strictEqual(body.successfulQueries, 4);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.url)
      .sort(),
    ['https://example.com/1', 'https://example.com/2', 'https://example.com/3']
      .sort()
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: keywordQuery, pageSize: 3, page: 1 },
    { query: keywordQuery, pageSize: 1, page: 2 },
    { query: 'AI', pageSize: 3, page: 1 },
    { query: 'Robotics', pageSize: 3, page: 1 },
    { query: 'healthcare', pageSize: 3, page: 1 },
  ]);
});

test('combines query and keyword string to reach the limit', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const responses = new Map([
    [
      'innovation|1',
      [
        {
          title: 'Innovation leaps ahead',
          description: 'Innovation leaps ahead globally',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'Next-gen materials emerge',
          description: 'New materials support breakthroughs',
          url: 'https://example.com/b',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
      ],
    ],
    ['innovation|2', []],
    [
      'biology AND space|1',
      [
        {
          title: 'Genome editing milestones',
          description: 'Genome editing reaches new milestones',
          url: 'https://example.com/c',
          source: { name: 'Source C' },
          publishedAt: '2024-01-03T00:00:00Z',
        },
        {
          title: 'Mars mission update',
          description: 'Mars mission update released',
          url: 'https://example.com/d',
          source: { name: 'Source D' },
          publishedAt: '2024-01-04T00:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'innovation', keywords: ['biology', 'space'], limit: 4 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, [
    'innovation',
    'biology AND space',
    'biology',
    'space',
  ]);
  assert.deepStrictEqual(fetchCalls, [
    { query: 'innovation', pageSize: 2, page: 1 },
    { query: 'biology AND space', pageSize: 2, page: 1 },
    { query: 'biology', pageSize: 2, page: 1 },
    { query: 'space', pageSize: 2, page: 1 },
  ]);
  assert.strictEqual(body.successfulQueries, 4);
  assert.strictEqual(body.totalResults, 4);
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.title)
      .sort(),
    [
      'Innovation leaps ahead',
      'Next-gen materials emerge',
      'Genome editing milestones',
      'Mars mission update',
    ].sort()
  );
});

test('continues paging when earlier results include duplicates', async () => {
  globalThis.__openaiCreate = async () => {
    return {
      choices: [
        {
          message: {
            content: '["second focus"]',
          },
        },
      ],
    };
  };

  const responses = new Map([
    [
      'first spotlight|1',
      [
        {
          title: 'Alpha insight',
          description: 'Alpha insight analysis',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Beta developments',
          description: 'Beta developments update',
          url: 'https://example.com/b',
          source: { name: 'Source B' },
          publishedAt: '2024-02-02T00:00:00Z',
        },
      ],
    ],
    [
      'first spotlight|2',
      [
        {
          title: 'Alpha insight',
          description: 'Alpha insight analysis',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Beta developments',
          description: 'Beta developments update',
          url: 'https://example.com/b',
          source: { name: 'Source B' },
          publishedAt: '2024-02-02T00:00:00Z',
        },
      ],
    ],
    [
      '"second focus"|1',
      [
        {
          title: 'Alpha insight',
          description: 'Alpha insight analysis',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Gamma outlook',
          description: 'Gamma outlook overview',
          url: 'https://example.com/c',
          source: { name: 'Source C' },
          publishedAt: '2024-02-03T00:00:00Z',
        },
      ],
    ],
    [
      '"second focus"|2',
      [
        {
          title: 'Delta forecast',
          description: 'Delta forecast briefing',
          url: 'https://example.com/d',
          source: { name: 'Source D' },
          publishedAt: '2024-02-04T00:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'first spotlight', keywords: ['second focus'], limit: 4 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, ['first spotlight', '"second focus"']);
  assert.strictEqual(body.successfulQueries, 2);
  assert.strictEqual(body.totalResults, 4);
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.url)
      .sort(),
    [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ].sort()
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: 'first spotlight', pageSize: 2, page: 1 },
    { query: '"second focus"', pageSize: 2, page: 1 },
    { query: '"second focus"', pageSize: 1, page: 2 },
  ]);
});

test('builds keyword query without OpenAI assistance', async () => {
  let openaiCalls = 0;
  globalThis.__openaiCreate = async () => {
    openaiCalls += 1;
    throw new Error('openai should not be called for direct keyword searches');
  };

  const keywordQuery = '"renewable energy" AND investment';
  const allowedQueries = new Set([
    keywordQuery,
    '"renewable energy"',
    'investment',
  ]);
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    assert.ok(allowedQueries.has(url.searchParams.get('q') || ''));
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return {
          status: 'ok',
          articles: [
            {
              title: 'Renewable energy investments climb',
              description: 'Investments in renewable energy climb globally.',
              url: 'https://example.com/renewable',
              source: { name: 'Energy Daily' },
              publishedAt: '2024-07-01T00:00:00Z',
            },
            {
              title: 'Solar funding surges',
              description: 'Solar funding surges across multiple markets.',
              url: 'https://example.com/solar',
              source: { name: 'Solar Journal' },
              publishedAt: '2024-07-02T00:00:00Z',
            },
          ],
        };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles: [] });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ keywords: ['renewable energy', 'investment'], limit: 2 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, [
    keywordQuery,
    '"renewable energy"',
    'investment',
  ]);
  assert.strictEqual(body.successfulQueries, 3);
  assert.strictEqual(body.totalResults, 2);
  assert.strictEqual(body.headlines.length, 2);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
  assert.strictEqual(openaiCalls, 0);
});

test('default dedupe keeps near-matching headlines separate', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const articles = [
    {
      title: 'AI testing leaps ahead',
      description: 'A new AI testing framework leaps ahead in clinical trials.',
      url: 'https://example.com/ai-testing-leaps',
      source: { name: 'Tech Source' },
      publishedAt: '2024-07-01T10:00:00Z',
    },
    {
      title: 'AI tests leap ahead',
      description: 'Latest AI tests leap ahead amid new frameworks and trials.',
      url: 'https://example.com/ai-tests-leap',
      source: { name: 'Science Daily' },
      publishedAt: '2024-07-01T12:00:00Z',
    },
  ];

  const newsApiUrl = 'https://newsapi.org/v2/everything';

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith(newsApiUrl)) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles });
        },
      };
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi should not be called');
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'ai testing breakthroughs', limit: 5 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.headlines.length, 2);
  const returnedUrls = body.headlines.map((item) => item.url).sort();
  assert.deepStrictEqual(returnedUrls, [
    'https://example.com/ai-testing-leaps',
    'https://example.com/ai-tests-leap',
  ]);
  for (const headline of body.headlines) {
    assert.ok(!headline.relatedArticles);
  }
});

test('strict dedupe collapses near-matching headlines', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const articles = [
    {
      title: 'AI testing leaps ahead',
      description: 'A new AI testing framework leaps ahead in clinical trials.',
      url: 'https://example.com/ai-testing-leaps',
      source: { name: 'Tech Source' },
      publishedAt: '2024-07-01T10:00:00Z',
    },
    {
      title: 'AI tests leap ahead',
      description: 'Latest AI tests leap ahead amid new frameworks and trials.',
      url: 'https://example.com/ai-tests-leap',
      source: { name: 'Science Daily' },
      publishedAt: '2024-07-01T12:00:00Z',
    },
  ];

  const newsApiUrl = 'https://newsapi.org/v2/everything';

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith(newsApiUrl)) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles });
        },
      };
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi should not be called');
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'ai testing breakthroughs',
      limit: 5,
      dedupeMode: 'strict',
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.headlines.length, 1);
  const [headline] = body.headlines;
  assert.strictEqual(headline.url, 'https://example.com/ai-testing-leaps');
  assert.ok(Array.isArray(headline.relatedArticles));
  assert.strictEqual(headline.relatedArticles.length, 1);
  const related = headline.relatedArticles[0];
  assert.strictEqual(related.url, 'https://example.com/ai-tests-leap');
  assert.ok(related.title.includes('AI tests'));
});

test('falls back to SERP with a default time filter when NewsAPI has no results', async () => {
  const originalSerpKey = process.env.SERPAPI_KEY;
  process.env.SERPAPI_KEY = 'serp-test-key';

  const serpCalls = [];

  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());

    assert.strictEqual(url.searchParams.get('from'), null);

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles: [] };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles: [] });
      },
    };
  };

  globalThis.__serpapiSearch = async (options) => {
    serpCalls.push(options);
    return [];
  };

  try {
    const handler = createHeadlinesHandler({ logger: { error() {} } });
    const response = await handler(
      createRequest({ query: 'breaking updates', limit: 3 })
    );

    assert.strictEqual(response.status, 200);
    await response.json();

    assert.strictEqual(serpCalls.length, 2);
    for (const call of serpCalls) {
      assert.strictEqual(call.extraParams?.tbs, 'qdr:w2');
    }
  } finally {
    if (originalSerpKey === undefined) {
      delete process.env.SERPAPI_KEY;
    } else {
      process.env.SERPAPI_KEY = originalSerpKey;
    }
  }
});
