import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const minLinksMatch = tsCode.match(/const MIN_LINKS = \d+;/);
const modelLimitsMatch = tsCode.match(/const MODEL_CONTEXT_LIMITS[\s\S]*?};/);
const funcMatch = tsCode.match(/async function generateWithLinks[\s\S]*?\n\}/);

const snippet = `
${minLinksMatch[0]}
${modelLimitsMatch[0]}
let responses = [];
let calls = [];
const openai = { chat: { completions: { create: async (opts) => { calls.push(opts); return responses.shift(); } } } };
${funcMatch[0]}
export { generateWithLinks, MIN_LINKS, responses, calls };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { generateWithLinks, MIN_LINKS, responses, calls } = await import(moduleUrl);

test('generateWithLinks retries when links are missing', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<p>No links here</p>' } }] },
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
  assert(content.includes('href="a"'));
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
