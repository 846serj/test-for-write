import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const escapeRegExpMatch = tsCode.match(/function escapeRegExp[\s\S]*?\n\}/);
const stripHtmlTagsMatch = tsCode.match(/function stripHtmlTags[\s\S]*?\n\}/);
const travelOptionsMatch = tsCode.match(
  /interface TravelStyleVerificationOptions[\s\S]*?\n\}/
);
const travelResultMatch = tsCode.match(
  /interface TravelStyleVerificationResult[\s\S]*?\n\}/
);
const verifyTravelStyleMatch = tsCode.match(
  /function verifyTravelStyle[\s\S]*?\n\}/
);

if (
  !escapeRegExpMatch ||
  !stripHtmlTagsMatch ||
  !travelOptionsMatch ||
  !travelResultMatch ||
  !verifyTravelStyleMatch
) {
  throw new Error('Failed to extract travel style helpers from route.ts');
}

function transpile(snippet) {
  const jsCode = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const moduleUrl =
    'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
  return import(moduleUrl);
}

test('verifyTravelStyle approves HTML with required travel cues', async () => {
  const snippet = `
${escapeRegExpMatch[0]}
${stripHtmlTagsMatch[0]}
${travelOptionsMatch[0]}
${travelResultMatch[0]}
${verifyTravelStyleMatch[0]}
const html = '<p>Plan a summer escape to Colorado with a flexible itinerary.</p>' +
  '<h2>Colorado Must-See Mountain Stops</h2>' +
  '<p>Start your morning exploring Rocky Mountain National Park, a must-see landmark with scenic stops and hiking trails for visitors planning their route.</p>' +
  '<p>Stay at boutique hotels in Estes Park for convenient lodging and sample downtown dining for locally sourced cuisine.</p>' +
  '<p>Visit in the shoulder season during fall for colorful foliage without peak season crowds.</p>';
const result = verifyTravelStyle(html, { travelState: 'Colorado' });
export { result };
`;
  const { result } = await transpile(snippet);
  assert.strictEqual(result.isValid, true);
  assert.deepStrictEqual(result.issues, []);
});

test('verifyTravelStyle flags missing travel cues', async () => {
  const snippet = `
${escapeRegExpMatch[0]}
${stripHtmlTagsMatch[0]}
${travelOptionsMatch[0]}
${travelResultMatch[0]}
${verifyTravelStyleMatch[0]}
const html = '<p>This piece talks vaguely about travel.</p>';
const result = verifyTravelStyle(html, { travelState: 'Colorado' });
export { result };
`;
  const { result } = await transpile(snippet);
  assert.strictEqual(result.isValid, false);
  assert(result.issues.length >= 1);
  assert(
    result.issues.some((issue) =>
      issue.includes('Mention Colorado frequently')
    ),
    'Missing state mention should be flagged.'
  );
  assert(
    result.issues.some((issue) => issue.includes('must-see stops')),
    'Missing attraction coverage should be flagged.'
  );
  assert(
    result.issues.some((issue) => issue.includes('lodging recommendations')),
    'Missing lodging guidance should be flagged.'
  );
  assert(
    result.issues.some((issue) => issue.includes('seasonal or timing')),
    'Missing seasonal guidance should be flagged.'
  );
});
