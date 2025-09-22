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
const normalizePublisherMatch = tsCode.match(/function normalizePublisher[\s\S]*?\n\}/);

const snippet = `
${typeMatch[0]}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
${resolveFreshnessMatch[0]}
${mapFreshnessMatch[0]}
${funcMatch[0]}
${normalizePublisherMatch ? normalizePublisherMatch[0] : ''}
export { fetchSources, serpCalls, setSerpResults };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { fetchSources, serpCalls, setSerpResults } = await import(moduleUrl);

test('fetchSources requests google_news with freshness filter and preserves order', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://example.com/newest', source: 'Example News' },
    { link: 'https://example.com/second', source: 'Another Source' },
    { link: 'https://example.com/newest', source: 'Example News' },
    { link: 'https://example.com/third', source: 'Third Source' },
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
  setSerpResults([{ link: 'https://example.com', source: 'Example' }]);
  await fetchSources('weekly topic', '7d');
  assert.strictEqual(serpCalls[0].extraParams?.tbs, 'qdr:w');
});

test('fetchSources skips results that share the same publisher source', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://example.com/article-a', source: 'Example News' },
    { link: 'https://example.com/article-b', source: 'Example News' },
    { link: 'https://different.com/story', source: 'Different Daily' },
  ]);

  const sources = await fetchSources('duplicate publishers');
  assert.deepStrictEqual(sources, [
    'https://example.com/article-a',
    'https://different.com/story',
  ]);
});

test('fetchSources deduplicates by hostname when source metadata is missing', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://www.host.com/article-1' },
    { link: 'https://host.com/article-2' },
    { link: 'https://another.com/story' },
  ]);

  const sources = await fetchSources('missing sources');
  assert.deepStrictEqual(sources, [
    'https://www.host.com/article-1',
    'https://another.com/story',
  ]);
});

test('fetchSources limits to five unique publishers while preserving order', async () => {
  serpCalls.length = 0;
  setSerpResults([
    { link: 'https://a.com/1', source: 'A' },
    { link: 'https://b.com/1', source: 'B' },
    { link: 'https://c.com/1', source: 'C' },
    { link: 'https://d.com/1', source: 'D' },
    { link: 'https://e.com/1', source: 'E' },
    { link: 'https://f.com/1', source: 'F' },
  ]);

  const sources = await fetchSources('many sources');
  assert.deepStrictEqual(sources, [
    'https://a.com/1',
    'https://b.com/1',
    'https://c.com/1',
    'https://d.com/1',
    'https://e.com/1',
  ]);
});
