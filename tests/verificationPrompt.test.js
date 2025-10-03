import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const routeTs = fs.readFileSync(routePath, 'utf8');

test('runGrokVerificationWithRetry accepts only the prompt parameter', () => {
  assert(
    /async function runGrokVerificationWithRetry\(\s*prompt: string\s*\): Promise<string>\s*{/.test(
      routeTs
    ),
    'runGrokVerificationWithRetry should only expect the user prompt.'
  );
});

test('runGrokVerificationWithRetry builds a user-only message payload', () => {
  const messageBlockMatch = routeTs.match(
    /const messages:[^=]*= \[[\s\S]*?\{ role: 'user', content: prompt }[\s\S]*?\];\s*\n\s*const response = await runChatCompletion/
  );
  assert(messageBlockMatch, 'Expected to locate message construction block.');
  const messageBlock = messageBlockMatch[0];
  assert(
    !messageBlock.includes("role: 'system'"),
    'System role message should no longer be injected for verification.'
  );
});

test('runGrokVerificationWithRetry requests streaming Grok completions', () => {
  const callMatch = routeTs.match(
    /runChatCompletion\(\s*{[\s\S]*?}\s*,\s*{\s*signal: controller\.signal\s*}\s*\)/
  );
  assert(callMatch, 'Expected to locate runChatCompletion invocation.');
  assert(
    callMatch[0].includes('stream: true'),
    'runGrokVerificationWithRetry should request streaming completions from Grok.'
  );
});

test('verifyOutput sends prompts directly to verification helpers', () => {
  assert(
    routeTs.includes('const hasGrokKey = Boolean(process.env.GROK_API_KEY?.trim());'),
    'verifyOutput should determine whether a Grok key is available.'
  );
  assert(
    routeTs.includes('const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY?.trim());'),
    'verifyOutput should determine whether an OpenAI key is available.'
  );
  assert(
    routeTs.includes('runGrokVerificationWithRetry(prompt);'),
    'verifyOutput should pass only the prompt to Grok verification.'
  );
  const openAiCalls = routeTs.match(/runOpenAIVerificationWithTimeout\(\s*prompt\s*\)/g);
  assert(openAiCalls && openAiCalls.length >= 1, 'OpenAI verification should receive just the prompt.');
});

test('deriveReferenceIsoTimestamp enforces future drift guard', () => {
  const helperMatch = routeTs.match(
    /function deriveReferenceIsoTimestamp\([\s\S]*?return new Date\(referenceTimestamp\)\.toISOString\(\);\s*\}/
  );
  assert(helperMatch, 'Expected deriveReferenceIsoTimestamp helper to be defined.');
  const helperBody = helperMatch[0];
  assert(
    helperBody.includes('MAX_FUTURE_DRIFT_MS'),
    'Helper should ignore timestamps that drift too far into the future.'
  );
  assert(
    helperBody.includes('parsePublishedTimestamp'),
    'Helper should parse publishedAt fields before comparison.'
  );
});

test('verifyOutput supports OpenAI-only verification path when Grok key missing', () => {
  const openAiOnlyBlock = routeTs.match(
    /if \(!hasGrokKey\) {([\s\S]*?)runOpenAIVerificationWithTimeout\(\s*prompt\s*\)/
  );
  assert(
    openAiOnlyBlock,
    'verifyOutput should call runOpenAIVerificationWithTimeout when Grok is unavailable.'
  );
});

test('verifyOutput enforces prompt size limits with truncation notices', () => {
  assert(
    routeTs.includes('const MAX_ARTICLE_HTML_LENGTH = 80_000;'),
    'Expected an article HTML length guard constant.'
  );
  assert(
    routeTs.includes('const MAX_SOURCE_PROMPT_LENGTH = 60_000;'),
    'Expected a sources prompt length guard constant.'
  );
  assert(
    /trimmedContent\.length > MAX_ARTICLE_HTML_LENGTH/.test(routeTs),
    'Article content should be sliced when exceeding the maximum length.'
  );
  assert(
    /formattedSources && formattedSources\.length > MAX_SOURCE_PROMPT_LENGTH/.test(routeTs),
    'Source listings should be sliced when exceeding the maximum length.'
  );
  assert(
    routeTs.includes('[Article truncated for verification]'),
    'Article truncation notice should be appended when slicing occurs.'
  );
  assert(
    routeTs.includes('[Sources truncated for verification]'),
    'Source truncation notice should be appended when slicing occurs.'
  );
});
