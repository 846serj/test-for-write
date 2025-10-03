import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const routeTs = fs.readFileSync(routePath, 'utf8');

test('runGrokVerificationWithRetry accepts optional timestamp parameter', () => {
  assert(
    /async function runGrokVerificationWithRetry\(\s*prompt: string,\s*currentIsoTimestamp\?: string\s*\)/.test(
      routeTs
    ),
    'runGrokVerificationWithRetry should accept the current ISO timestamp.'
  );
});

test('runGrokVerificationWithRetry adds system message with current timestamp', () => {
  const messageBlockMatch = routeTs.match(
    /const messages[^=]*= currentIsoTimestamp[\s\S]*?\n\s*const response = await runChatCompletion/
  );
  assert(messageBlockMatch, 'Expected to locate message construction block.');
  const messageBlock = messageBlockMatch[0];
  assert(
    messageBlock.includes("role: 'system'"),
    'System role message should be included when timestamp is available.'
  );
  assert(
    messageBlock.includes('The current date and time is ${currentIsoTimestamp}'),
    'System message should mention the current ISO timestamp.'
  );
  assert(
    messageBlock.includes(": [{ role: 'user', content: prompt }]"),
    'Fallback to a user-only message should remain for missing timestamps.'
  );
});

test('verifyOutput passes current timestamp into verification helper', () => {
  assert(
    routeTs.includes('const nowIso = new Date().toISOString();'),
    'verifyOutput should capture the current ISO timestamp.'
  );
  assert(
    routeTs.includes('runGrokVerificationWithRetry(prompt, nowIso)'),
    'verifyOutput should pass the timestamp to the verification helper.'
  );
});
