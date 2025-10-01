import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { beforeEach, test } from 'node:test';

const routePath = new URL('../src/app/api/headlines/review/route.ts', import.meta.url);
const tsSource = fs.readFileSync(routePath, 'utf8');

const sanitizedSource = tsSource
  .replace(
    "import { NextRequest, NextResponse } from 'next/server';\n",
    'const NextResponse = globalThis.__nextResponse;\n'
  )
  .replace(
    "import type { PresetCategory } from '../../../../constants/headlineSites';\n",
    'type PresetCategory = any;\n'
  )
  .replace(
    "import {\n  reviewHeadlinesAgainstCategories,\n  type HeadlineCategoryReviewResult,\n  type ReviewableHeadline,\n} from '../../../../lib/headlineCategoryReview';\n",
    "const reviewHeadlinesAgainstCategories = (...args) => globalThis.__headlineReviewHelper.reviewHeadlinesAgainstCategories(...args);\n type HeadlineCategoryReviewResult = any;\n type ReviewableHeadline = any;\n"
  );

const jsCode = ts
  .transpileModule(sanitizedSource, {
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

globalThis.__headlineReviewHelper = {
  reviewHeadlinesAgainstCategories: () => {
    throw new Error('review helper not stubbed');
  },
};

const { POST } = await import(moduleUrl);

function createRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

beforeEach(() => {
  globalThis.__headlineReviewHelper.reviewHeadlinesAgainstCategories = () => {
    throw new Error('review helper not stubbed');
  };
});

test('rejects requests without array payloads', async () => {
  const response = await POST(createRequest({ categories: {}, headlines: {} }));
  assert.strictEqual(response.status, 400);
  const body = await response.json();
  assert.strictEqual(body.error, 'headlines must be an array');
});

test('flags unmatched headlines via helper output', async () => {
  const helperResults = [
    {
      index: 0,
      status: 'matched',
      categoryId: 'global-affairs',
      categoryLabel: 'Global Affairs & Security',
      matchedTerms: ['security'],
      score: 6,
    },
    {
      index: 1,
      status: 'unmatched',
      categoryId: null,
      categoryLabel: null,
      matchedTerms: [],
      score: 0,
    },
  ];

  globalThis.__headlineReviewHelper.reviewHeadlinesAgainstCategories = () => helperResults;

  const response = await POST(
    createRequest({
      categories: [{ id: 'global-affairs', label: 'Global Affairs & Security' }],
      headlines: [
        { title: 'NATO ministers meet to discuss joint security posture' },
        { title: 'New art exhibit opens downtown' },
      ],
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.results, helperResults);
  assert.strictEqual(body.unmatchedCount, 1);
});
