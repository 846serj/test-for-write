import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const typeMatch = tsCode.match(/type NewsFreshness[^;]+;/);
const resolveFreshnessMatch = tsCode.match(/function resolveFreshness[\s\S]*?\n\}/);
const mapFreshnessMatch = tsCode.match(/function mapFreshnessToSerpTbs[\s\S]*?\n\}/);
const funcMatch = tsCode.match(/async function fetchSources[\s\S]*?\n\}/);

const snippet = `
${typeMatch[0]}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
${resolveFreshnessMatch[0]}
${mapFreshnessMatch[0]}
${funcMatch[0]}
export { fetchSources, serpCalls, setSerpResults };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { fetchSources, serpCalls, setSerpResults } = await import(moduleUrl);

test('fetchSources requests google_news with freshness filter and preserves order', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://example.com/newest' },
    { link: 'https://example.com/second' },
    { link: 'https://example.com/newest' },
    { link: 'https://example.com/third' },
  ]);
  const sources = await fetchSources('breaking topic', '1h');
  assert.strictEqual(serpCalls.length, 1);
  assert.strictEqual(serpCalls[0].engine, 'google_news');
  assert.strictEqual(serpCalls[0].query, 'breaking topic');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:h');
  assert.strictEqual(serpCalls[0].limit, 8);
  assert.deepStrictEqual(sources, [
    'https://example.com/newest',
    'https://example.com/second',
    'https://example.com/third',
  ]);
});

test('fetchSources defaults to 6h freshness when none provided', async () => {
  serpCalls.length = 0;
  setSerpResults([{ link: 'https://example.com' }]);
  await fetchSources('another topic');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:h6');
});

test('fetchSources uses past 7 days filter when requested', async () => {
  serpCalls.length = 0;
  setSerpResults([{ link: 'https://example.com' }]);
  await fetchSources('weekly topic', '7d');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:w');
});
