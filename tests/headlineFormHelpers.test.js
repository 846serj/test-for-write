import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const helpersPath = new URL('../src/app/generate/headlineFormHelpers.ts', import.meta.url);
const tsSource = fs.readFileSync(helpersPath, 'utf8');

const snippet = `
${tsSource}
export { normalizeKeywordInput, buildHeadlineRequest };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const { normalizeKeywordInput, buildHeadlineRequest } = await import(moduleUrl);

test('normalizeKeywordInput deduplicates mixed separators while preserving order', () => {
  const result = normalizeKeywordInput('AI, robotics\nAI, space exploration\nSpace Exploration');
  assert.deepStrictEqual(result, ['AI', 'robotics', 'space exploration']);
});

test('buildHeadlineRequest enforces keywords or prompt', () => {
  const result = buildHeadlineRequest({
    prompt: '   ',
    keywords: [],
    profileQuery: '',
    profileLanguage: null,
    limit: 5,
    sortBy: 'publishedAt',
    language: 'en',
    fromDate: '',
    toDate: '',
    searchIn: [],
    sourcesInput: '',
    domainsInput: '',
    excludeDomainsInput: '',
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(
    result.error,
    'Provide at least one keyword or describe the article to fetch headlines.'
  );
});

test('buildHeadlineRequest creates keyword-only payloads', () => {
  const keywords = normalizeKeywordInput(
    'climate change, Climate Change, renewables'
  );

  const result = buildHeadlineRequest({
    prompt: '',
    keywords,
    profileQuery: '',
    profileLanguage: null,
    limit: 7,
    sortBy: 'relevancy',
    language: 'all',
    fromDate: '',
    toDate: '',
    searchIn: ['description', 'content'],
    sourcesInput: 'bbc-news, the-verge',
    domainsInput: '',
    excludeDomainsInput: '',
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.payload, {
    limit: 7,
    sortBy: 'relevancy',
    keywords,
    searchIn: ['description', 'content'],
    sources: ['bbc-news', 'the-verge'],
  });
});

test('buildHeadlineRequest prefers prompt language and surfaces conflicts', () => {
  const conflict = buildHeadlineRequest({
    prompt: 'Tech policy updates',
    keywords: [],
    profileQuery: '',
    profileLanguage: 'ES',
    limit: 4,
    sortBy: 'publishedAt',
    language: 'all',
    fromDate: '',
    toDate: '',
    searchIn: [],
    sourcesInput: 'bbc-news, bbc-news',
    domainsInput: 'example.com',
    excludeDomainsInput: '',
  });

  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(
    conflict.error,
    'Choose either specific sources or domain filters. NewsAPI does not allow combining them.'
  );
  assert.deepStrictEqual(conflict.sanitizedSources, ['bbc-news']);
  assert.deepStrictEqual(conflict.sanitizedDomains, ['example.com']);

  const success = buildHeadlineRequest({
    prompt: '  Tech policy updates  ',
    keywords: [],
    profileQuery: '',
    profileLanguage: 'ES',
    limit: 4,
    sortBy: 'publishedAt',
    language: 'all',
    fromDate: '',
    toDate: '',
    searchIn: [],
    sourcesInput: '',
    domainsInput: '',
    excludeDomainsInput: '',
  });

  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.payload.query, 'Tech policy updates');
  assert.strictEqual(success.payload.language, 'es');
  assert.strictEqual(success.resolvedPrompt, 'Tech policy updates');
});
