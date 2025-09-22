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
  .replace("import { openai } from '../../../lib/openai';", '')
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
const openai = globalThis.__openai;
const fetch = globalThis.__fetch;
const serpapiSearch = (...args) => globalThis.__serpapiSearch(...args);
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

test('infers keywords when only a description is provided', async () => {
  const openaiCalls = [];
  globalThis.__openaiCreate = async (options) => {
    openaiCalls.push(options);
    if (openaiCalls.length === 1) {
      return {
        choices: [
          {
            message: {
              content: '{}',
            },
          },
        ],
      };
    }

    if (openaiCalls.length === 2) {
      return {
        choices: [
          {
            message: {
              content: '["AI robotics AND \\\"health tech\\\""]',
            },
          },
        ],
      };
    }

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
  const descriptionQuery =
    'Focus on technology-driven AI robotics transforming hospital care.';
  const keywordQuery = 'AI robotics AND "health tech"';
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    fetchCalls.push({
      query: url.searchParams.get('q') || '',
      pageSize: Number(url.searchParams.get('pageSize')),
      page: Number(url.searchParams.get('page')),
    });

    const query = url.searchParams.get('q') || '';
    const articles = query === descriptionQuery ? [] : [
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

  assert.strictEqual(openaiCalls.length, 3);
  assert.ok(openaiCalls[0].messages?.[1]?.content.includes(description));
  assert.deepStrictEqual(body.inferredKeywords, [
    'Focus',
    'technology',
    'driven',
    'robotics',
    'transforming',
  ]);
  assert.deepStrictEqual(body.inferredCategories, ['technology']);
  assert.deepStrictEqual(body.queriesAttempted, [keywordQuery]);
  assert.deepStrictEqual(fetchCalls, [
    { query: keywordQuery, pageSize: 3, page: 1 },
  ]);
  assert.strictEqual(body.successfulQueries, 1);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
});

test('aggregates deduplicated results for keyword expansions', async () => {
  const openaiCalls = [];
  globalThis.__openaiCreate = async (options) => {
    openaiCalls.push(options);
    return {
      choices: [
        {
          message: {
            content:
              '["robotics AND \\\"AI\\\"","AI healthcare OR \\\"medical robotics\\\""]',
          },
        },
      ],
    };
  };

  const responses = new Map([
    [
      'robotics AND "AI"',
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
      ],
    ],
    [
      'AI healthcare OR "medical robotics"',
      [
        {
          title: 'AI in hospitals',
          description: 'Hospitals adopt AI for patient care',
          url: 'https://example.com/2',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
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
    const articles = responses.get(query) ?? [];
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
  const expansionCalls = openaiCalls.filter((options) =>
    options?.messages?.[1]?.content?.includes('Convert the following keywords')
  );
  assert.strictEqual(expansionCalls.length, 1);
  assert.deepStrictEqual(
    body.queriesAttempted,
    ['robotics AND "AI"', 'AI healthcare OR "medical robotics"']
  );
  assert.strictEqual(body.successfulQueries, 2);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.url)
      .sort(),
    ['https://example.com/1', 'https://example.com/2', 'https://example.com/3']
      .sort()
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: 'robotics AND "AI"', pageSize: 2, page: 1 },
    { query: 'robotics AND "AI"', pageSize: 1, page: 2 },
    { query: 'AI healthcare OR "medical robotics"', pageSize: 1, page: 1 },
  ]);
});

test('continues fetching additional keyword queries until the limit is satisfied', async () => {
  globalThis.__openaiCreate = async () => {
    return {
      choices: [
        {
          message: {
            content: '["biology breakthroughs","space exploration"]',
          },
        },
      ],
    };
  };

  const responses = new Map([
    [
      'innovation',
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
    [
      'biology breakthroughs',
      [
        {
          title: 'Innovation leaps ahead',
          description: 'Innovation leaps ahead globally',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'Genome editing milestones',
          description: 'Genome editing reaches new milestones',
          url: 'https://example.com/c',
          source: { name: 'Source C' },
          publishedAt: '2024-01-03T00:00:00Z',
        },
      ],
    ],
    [
      'space exploration',
      [
        {
          title: 'Mars mission update',
          description: 'Mars mission update released',
          url: 'https://example.com/d',
          source: { name: 'Source D' },
          publishedAt: '2024-01-04T00:00:00Z',
        },
        {
          title: 'Europa lander preparations',
          description: 'Europa lander preparations advance',
          url: 'https://example.com/e',
          source: { name: 'Source E' },
          publishedAt: '2024-01-05T00:00:00Z',
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
    const articles = responses.get(query) ?? [];
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
    'biology breakthroughs',
    'space exploration',
  ]);
  assert.deepStrictEqual(fetchCalls, [
    { query: 'innovation', pageSize: 2, page: 1 },
    { query: 'innovation', pageSize: 2, page: 2 },
    { query: 'biology breakthroughs', pageSize: 2, page: 1 },
    { query: 'biology breakthroughs', pageSize: 1, page: 2 },
    { query: 'space exploration', pageSize: 1, page: 1 },
  ]);
  assert.strictEqual(body.successfulQueries, 3);
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
      'second focus|1',
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
      'second focus|2',
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
  assert.deepStrictEqual(body.queriesAttempted, ['first spotlight', 'second focus']);
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
    { query: 'first spotlight', pageSize: 2, page: 2 },
    { query: 'second focus', pageSize: 2, page: 1 },
    { query: 'second focus', pageSize: 1, page: 2 },
  ]);
});

test('retains later valid summary bullets after filtering oversized entries', async () => {
  const invalidBullet =
    'This intentionally verbose bullet contains far more than thirty individual words because it keeps rambling about hypothetical developments in international markets without ever stopping for clarity or concision at all today.';
  const validBullets = [
    'Launch officials confirm three satellites reached orbit Monday.',
    'Mission timeline notes refueling operations begin Friday at Cape Canaveral.',
    'Agency says public updates will stream hourly via dedicated portal.',
  ];

  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    assert.strictEqual(url.searchParams.get('q'), 'orbital science');
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
              title: 'Orbital science milestone',
              description: 'Agencies report orbital science milestone details.',
              url: 'https://example.com/orbital',
              source: { name: 'Science Journal' },
              publishedAt: '2024-05-01T00:00:00Z',
            },
          ],
        };
      },
      async text() {
        return JSON.stringify({
          status: 'ok',
          articles: [
            {
              title: 'Orbital science milestone',
              description: 'Agencies report orbital science milestone details.',
              url: 'https://example.com/orbital',
              source: { name: 'Science Journal' },
              publishedAt: '2024-05-01T00:00:00Z',
            },
          ],
        });
      },
    };
  };

  let openaiCalls = 0;
  globalThis.__openaiCreate = async (options) => {
    openaiCalls += 1;
    const userContent = options?.messages?.[1]?.content ?? '';
    assert.ok(
      typeof userContent === 'string' &&
        userContent.includes('Summarize each news cluster strictly as JSON'),
      'expected summarization request'
    );

    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              'item-0': [
                invalidBullet,
                invalidBullet,
                invalidBullet,
                invalidBullet,
                invalidBullet,
                ...validBullets,
              ],
            }),
          },
        },
      ],
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(createRequest({ query: 'orbital science', limit: 1 }));

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(openaiCalls, 1);
  assert.strictEqual(body.headlines.length, 1);
  const summary = body.headlines[0].summary;
  assert.deepStrictEqual(summary, validBullets);
  for (const bullet of summary) {
    const words = bullet.split(/\s+/).filter(Boolean);
    assert.ok(words.length > 0 && words.length <= 30);
  }
});

test('surfaces expansion failures from OpenAI', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('boom');
  };

  const fetchInvocations = [];
  globalThis.__fetchImpl = async (...args) => {
    fetchInvocations.push(args);
    throw new Error('should not reach fetch');
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(createRequest({ keywords: ['economy'] }));

  assert.strictEqual(response.status, 502);
  const body = await response.json();
  assert.strictEqual(body.error, 'Failed to expand keyword searches');
  assert.strictEqual(fetchInvocations.length, 0);
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
