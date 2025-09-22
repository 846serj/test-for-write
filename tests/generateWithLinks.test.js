import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const minLinksMatch = tsCode.match(/const MIN_LINKS = \d+;/);
const factualTempMatch = tsCode.match(/const FACTUAL_TEMPERATURE\s*=\s*[^;]+;/);
const modelLimitsMatch = tsCode.match(/const MODEL_CONTEXT_LIMITS[\s\S]*?};/);
const normalizeHrefMatch = tsCode.match(/function normalizeHrefValue[\s\S]*?\n\}/);
const linksClusteredMatch = tsCode.match(/function linksClusteredNearEnd[\s\S]*?\n\}/);
const buildVariantsMatch = tsCode.match(
  /function buildUrlVariants[\s\S]*?return Array\.from\(variants\);\n\}/
);
const cleanOutputMatch = tsCode.match(/function cleanModelOutput[\s\S]*?\n\}/);
const findMissingMatch = tsCode.match(/function findMissingSources[\s\S]*?\n\}/);
const anchorHelperMatch = tsCode.match(
  /type AnchorReplacement[\s\S]*?function ensureRequiredSourceAnchors[\s\S]*?return updated;\n\}/
);
const funcMatch = tsCode.match(/async function generateWithLinks[\s\S]*?\n\}/);

const snippet = `
${minLinksMatch[0]}
${factualTempMatch[0]}
${modelLimitsMatch[0]}
${normalizeHrefMatch[0]}
${linksClusteredMatch[0]}
${buildVariantsMatch[0]}
${cleanOutputMatch[0]}
${findMissingMatch[0]}
${anchorHelperMatch[0]}
let responses = [];
let calls = [];
const openai = { chat: { completions: { create: async (opts) => { calls.push(opts); return responses.shift(); } } } };
${funcMatch[0]}
export { generateWithLinks, MIN_LINKS, responses, calls, findMissingSources };
`;

const jsCode = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2018 },
}).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { generateWithLinks, MIN_LINKS, responses, calls, findMissingSources } = await import(moduleUrl);

test('generateWithLinks names missing sources when retrying', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<a href="a">1</a>' } }] },
    { choices: [{ message: { content: '<a href="a">1</a><a href="b">2</a><a href="c">3</a>' } }] }
  );
  const systemPrompt = 'system context';
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['a', 'b', 'c', 'd'],
    systemPrompt,
    MIN_LINKS,
    100
  );
  assert(content.includes('href="c"'));
  assert(!content.includes('href="d"'));
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 2);
  for (const call of calls) {
    assert.strictEqual(call.messages.length, 2);
    assert.deepStrictEqual(call.messages[0], {
      role: 'system',
      content: systemPrompt,
    });
    assert.strictEqual(call.messages[1].role, 'user');
  }
  const retryMessage = calls[1].messages[calls[1].messages.length - 1].content;
  assert(/You failed to cite/.test(retryMessage));
  const missingLines = retryMessage
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  assert.deepStrictEqual(missingLines, ['- b', '- c']);
});

test('generateWithLinks succeeds when optional sources are uncited', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({
    choices: [
      {
        message: {
          content: '<a href="a">1</a><a href="b">2</a><a href="c">3</a>',
        },
      },
    ],
  });
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['a', 'b', 'c', 'd', 'e'],
    undefined,
    MIN_LINKS,
    100
  );
  assert(content.includes('href="a"'));
  assert(!content.includes('href="d"'));
  assert(!content.includes('href="e"'));
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 1);
});

test('generateWithLinks retries when response is truncated', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] }
  );
  const content = await generateWithLinks('prompt', 'model', [], undefined, 0, 100);
  assert.strictEqual(content, 'complete');
  assert(calls[1].max_tokens > calls[0].max_tokens);
  assert.strictEqual(responses.length, 0);
  for (const call of calls) {
    assert.strictEqual(call.messages.length, 1);
    assert.strictEqual(call.messages[0].role, 'user');
  }
});

test('generateWithLinks retries when output too short', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<p>short</p>' } }] },
    { choices: [{ message: { content: '<p>long enough content</p>' } }] }
  );
  const content = await generateWithLinks('prompt', 'model', [], undefined, 0, 100, 5);
  assert(content.includes('long enough'));
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 2);
  for (const call of calls) {
    assert.strictEqual(call.messages.length, 1);
    assert.strictEqual(call.messages[0].role, 'user');
  }
});

test('generateWithLinks injects missing required sources instead of throwing', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<a href="a">1</a>' } }] },
    { choices: [{ message: { content: '<p>Paragraph one.</p><p>Paragraph two.</p>' } }] }
  );
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['a', 'b', 'c', 'd'],
    undefined,
    MIN_LINKS,
    100
  );
  assert(content.includes('href="a"'));
  assert(content.includes('href="b" target="_blank" rel="noopener"'));
  assert(content.includes('href="c" target="_blank" rel="noopener"'));
  assert(!content.includes('href="d" target="_blank" rel="noopener"'));
  const sourceMatches = content.match(/href="[^"]+"/g) || [];
  const occurrences = sourceMatches.reduce((acc, match) => {
    const href = match.slice('href="'.length, -1);
    acc[href] = (acc[href] || 0) + 1;
    return acc;
  }, {});
  assert.strictEqual(occurrences.a, 1);
  assert.strictEqual(occurrences.b, 1);
  assert.strictEqual(occurrences.c, 1);
  assert.strictEqual(calls.length, 2);
});

test('findMissingSources detects uncited URLs even with encoded hrefs', () => {
  const html =
    '<a href="https://example.com/story">One</a> <a href="https://demo.com/article?a=1&amp;b=2">Two</a>';
  const missing = findMissingSources(html, [
    'https://example.com/story',
    'https://demo.com/article?a=1&b=2',
    'https://third.com/miss',
  ]);
  assert.deepStrictEqual(missing, ['https://third.com/miss']);
});

test('findMissingSources accepts host and protocol variants', () => {
  const html =
    '<a href="https://www.example.com/story">One</a> <a href="http://sample.com/path">Two</a>';
  const missing = findMissingSources(html, [
    'https://example.com/story',
    'https://www.sample.com/path',
    'https://third.com/miss',
  ]);
  assert.deepStrictEqual(missing, ['https://third.com/miss']);
});

test('findMissingSources treats URLs as equivalent without query strings', () => {
  const html = '<a href="https://example.com/story?utm_source=feed">One</a>';
  const missing = findMissingSources(html, ['https://example.com/story']);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources matches sources that include query strings', () => {
  const html = '<a href="https://example.com/story">One</a>';
  const missing = findMissingSources(html, ['https://example.com/story?utm_source=feed']);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources treats Google News redirect targets as cited', () => {
  const html = '<a href="https://www.example.com/story">Example</a>';
  const googleNewsUrl =
    'https://news.google.com/articles/CBMiXmh0dHBzOi8vd3d3LmV4YW1wbGUuY29tL3N0b3J5P3V0bV9zb3VyY2U9Z29vZ2xl?hl=en-US&gl=US&ceid=US:en';
  const missing = findMissingSources(html, [googleNewsUrl]);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources resolves Google tracking redirects', () => {
  const html = '<a href="https://www.example.com/story">Example</a>';
  const googleRedirectUrl =
    'https://www.google.com/url?url=https%3A%2F%2Fwww.example.com%2Fstory%3Futm_source%3Dgoogle&sa=t';
  const missing = findMissingSources(html, [googleRedirectUrl]);
  assert.deepStrictEqual(missing, []);
});
