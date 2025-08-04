import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const funcMatch = tsCode.match(/async function fetchSources[\s\S]*?\n\}/);

const snippet = `
let results = {
  google: [],
  google_news: [],
  google_scholar: []
};
async function serpapiSearch(_q, engine) { return results[engine]; }
${funcMatch[0]}
export { fetchSources, results };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { fetchSources, results } = await import(moduleUrl);

test('fetchSources removes duplicate links', async () => {
  results.google = ['a', 'b'];
  results.google_news = ['b'];
  results.google_scholar = ['c', 'a'];
  const sources = await fetchSources('test');
  assert.deepStrictEqual(sources.slice(0, 3).sort(), ['a','b','c']);
});
