import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { beforeEach, test } from 'node:test';

const routePath = new URL('../src/app/api/headlines/route.ts', import.meta.url);
const tsSource = fs.readFileSync(routePath, 'utf8');

const sanitizedSource = tsSource
  .replace("import { NextRequest, NextResponse } from 'next/server';", '')
  .replace("import { openai } from '../../../lib/openai';", '');

const snippet = `
const NextResponse = globalThis.__nextResponse;
const openai = globalThis.__openai;
const fetch = globalThis.__fetch;
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
});

test('rejects requests without query or keywords', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };
  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(createRequest({ limit: 5 }));
  assert.strictEqual(response.status, 400);
  const body = await response.json();
  assert.strictEqual(body.error, 'Either query or keywords must be provided');
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
          description: 'desc',
          url: 'https://example.com/1',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'AI in hospitals',
          description: 'desc',
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
          description: 'desc',
          url: 'https://example.com/2',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
        {
          title: 'Care robots expand',
          description: 'desc',
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
  assert.strictEqual(openaiCalls.length, 1);
  assert.deepStrictEqual(
    body.queriesAttempted,
    ['robotics AND "AI"', 'AI healthcare OR "medical robotics"']
  );
  assert.strictEqual(body.successfulQueries, 2);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  assert.deepStrictEqual(
    body.headlines.map((item) => item.url),
    ['https://example.com/1', 'https://example.com/2', 'https://example.com/3']
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
          description: 'desc',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'Next-gen materials emerge',
          description: 'desc',
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
          description: 'desc',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'Genome editing milestones',
          description: 'desc',
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
          description: 'desc',
          url: 'https://example.com/d',
          source: { name: 'Source D' },
          publishedAt: '2024-01-04T00:00:00Z',
        },
        {
          title: 'Europa lander preparations',
          description: 'desc',
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
    body.headlines.map((item) => item.title),
    [
      'Innovation leaps ahead',
      'Next-gen materials emerge',
      'Genome editing milestones',
      'Mars mission update',
    ]
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
          description: 'desc',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Beta developments',
          description: 'desc',
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
          description: 'desc',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Beta developments',
          description: 'desc',
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
          description: 'desc',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-02-01T00:00:00Z',
        },
        {
          title: 'Gamma outlook',
          description: 'desc',
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
          description: 'desc',
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
    body.headlines.map((item) => item.url),
    [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ]
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: 'first spotlight', pageSize: 2, page: 1 },
    { query: 'first spotlight', pageSize: 2, page: 2 },
    { query: 'second focus', pageSize: 2, page: 1 },
    { query: 'second focus', pageSize: 1, page: 2 },
  ]);
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
