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
    ['a', 'b', 'c'],
    systemPrompt,
    MIN_LINKS,
    100
  );
  assert(content.includes('href="c"'));
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
  assert(retryMessage.includes('b'));
  assert(retryMessage.includes('c'));
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

test('generateWithLinks throws when sources remain uncited', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<a href="a">1</a>' } }] },
    { choices: [{ message: { content: '<a href="a">1</a>' } }] }
  );
  await assert.rejects(
    () =>
      generateWithLinks('prompt', 'model', ['a', 'b'], undefined, MIN_LINKS, 100),
    /failed to cite required sources/i
  );
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
