import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const helpersPath = new URL('../src/app/generate/headlineFormHelpers.ts', import.meta.url);
const categoryConfigPath = new URL('../src/constants/categoryFeeds.ts', import.meta.url);
const tsSource = fs.readFileSync(helpersPath, 'utf8');
const categorySource = fs.readFileSync(categoryConfigPath, 'utf8');

const sanitizedHelpersSource = tsSource
  .replace(
    "import { CATEGORY_FEED_SET } from '../../constants/categoryFeeds';\n\n",
    ''
  )
  .replace(
    "import { isCategoryFeedValue } from '../../constants/categoryFeeds';\n\n",
    ''
  );

const snippet = `
${categorySource}
${sanitizedHelpersSource}
export { normalizeKeywordInput, buildHeadlineRequest, normalizeSummaryBullets, CATEGORY_FEED_CONFIG, CATEGORY_FEED_VALUES };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const {
  normalizeKeywordInput,
  buildHeadlineRequest,
  normalizeSummaryBullets,
  CATEGORY_FEED_CONFIG,
  CATEGORY_FEED_VALUES,
} = await import(moduleUrl);

test('normalizeKeywordInput deduplicates mixed separators while preserving order', () => {
  const result = normalizeKeywordInput('AI, robotics\nAI, space exploration\nSpace Exploration');
  assert.deepStrictEqual(result, ['AI', 'robotics', 'space exploration']);
});

test('normalizeSummaryBullets preserves structured fallback bullet lists', () => {
  const raw = {
    bullets: [
      '  Local council approves community center funding after months of debate.  ',
      'Community center funding approved Tuesday evening by a 5-4 vote following months of public comment and budget negotiations across the district leadership board members.',
      'Detail not provided in source.',
      '',
    ],
  };

  const result = normalizeSummaryBullets(raw);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(
    result[0],
    'Local council approves community center funding after months of debate.'
  );
  assert.ok(result[1].startsWith('Community center funding approved Tuesday evening'));
  const secondWords = result[1].split(/\s+/).filter(Boolean);
  assert.ok(secondWords.length <= 30);
  assert.strictEqual(result[2], 'Detail not provided in source.');
  for (const bullet of result) {
    const words = bullet.split(/\s+/).filter(Boolean);
    assert.ok(words.length > 0 && words.length <= 30);
  }
});

test('normalizeSummaryBullets returns empty array for non-list values', () => {
  assert.deepStrictEqual(normalizeSummaryBullets('single summary string'), []);
  assert.deepStrictEqual(normalizeSummaryBullets(null), []);
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
    category: '',
    country: '',
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(
    result.error,
    'Provide at least one keyword, choose a category feed, or describe the article to fetch headlines.'
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
    category: '',
    country: '',
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
    category: '',
    country: '',
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
    category: '',
    country: '',
  });

  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.payload.description, 'Tech policy updates');
  assert.ok(!('query' in success.payload));
  assert.strictEqual(success.payload.language, 'es');
  assert.strictEqual(success.resolvedPrompt, 'Tech policy updates');
});

test('buildHeadlineRequest falls back to profile query when no description is provided', () => {
  const result = buildHeadlineRequest({
    prompt: '   ',
    keywords: [],
    profileQuery: 'Space station maintenance',
    profileLanguage: null,
    limit: 6,
    sortBy: 'publishedAt',
    language: 'en',
    fromDate: '',
    toDate: '',
    searchIn: [],
    sourcesInput: '',
    domainsInput: '',
    excludeDomainsInput: '',
    category: '',
    country: '',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payload.query, 'Space station maintenance');
  assert.ok(!('description' in result.payload));
  assert.strictEqual(result.resolvedPrompt, 'Space station maintenance');
});

test('buildHeadlineRequest accepts every configured category feed', () => {
  for (const feed of CATEGORY_FEED_CONFIG) {
    const result = buildHeadlineRequest({
      prompt: '',
      keywords: [],
      profileQuery: '',
      profileLanguage: null,
      limit: 5,
      sortBy: 'publishedAt',
      language: 'all',
      fromDate: '',
      toDate: '',
      searchIn: [],
      sourcesInput: '',
      domainsInput: '',
      excludeDomainsInput: '',
      category: feed.value,
      country: '',
    });

    assert.strictEqual(result.ok, true, `Expected ${feed.value} to be accepted`);
    assert.strictEqual(result.payload.category, feed.value);
  }
});

test('buildHeadlineRequest rejects unsupported categories', () => {
  const unsupported = 'not-real-category';
  assert.ok(!CATEGORY_FEED_VALUES.includes(unsupported));

  const result = buildHeadlineRequest({
    prompt: '',
    keywords: [],
    profileQuery: '',
    profileLanguage: null,
    limit: 5,
    sortBy: 'publishedAt',
    language: 'all',
    fromDate: '',
    toDate: '',
    searchIn: [],
    sourcesInput: '',
    domainsInput: '',
    excludeDomainsInput: '',
    category: unsupported,
    country: '',
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'Unsupported category feed: not-real-category');
});
