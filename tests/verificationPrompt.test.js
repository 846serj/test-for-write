import assert from 'assert';
import fs from 'fs';
import { createRequire } from 'module';
import { test } from 'node:test';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { transformSync } from 'esbuild';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const routeTs = fs.readFileSync(routePath, 'utf8');
const routeFilename = fileURLToPath(routePath);
const transformedRouteTs = transformSync(routeTs, {
  loader: 'ts',
  format: 'cjs',
  target: 'es2020',
}).code;

function createVerificationSandbox(envOverrides = {}) {
  const infoLogs = [];
  const baseRequire = createRequire(routePath);
  const mockModules = new Map([
    ['next/server', { NextResponse: class {} }],
    [
      '../../../lib/openai',
      {
        getOpenAI: () => ({
          chat: {
            completions: {
              create: async () => ({ choices: [{ message: { content: '{}' } }] }),
            },
          },
        }),
      },
    ],
    [
      '../../../lib/grok',
      {
        DEFAULT_GROK_MODEL: 'grok-test',
        runChatCompletion: async () => ({ choices: [{ message: { content: '{}' } }] }),
      },
    ],
    ['../../../constants/lengthOptions', { DEFAULT_WORDS: 600, WORD_RANGES: {} }],
    ['../../../lib/serpapi', { serpapiSearch: async () => ({}) }],
    [
      '../../../lib/themeCoverage',
      {
        formatThemeCoverageIssue: (issue) => `Theme issue: ${issue}`,
        parseThemeCoverageIssue: () => null,
        resolveThemeThreshold: (value) => (typeof value === 'number' ? value : 0.5),
        validateThemeCoverage: () => null,
      },
    ],
  ]);

  const sandbox = {
    console: {
      info: (...args) => infoLogs.push(args.join(' ')),
      warn: () => {},
      error: () => {},
      log: () => {},
      debug: () => {},
      trace: () => {},
    },
    process: { env: { GROK_API_KEY: 'test-grok-key', ...envOverrides } },
    setTimeout,
    clearTimeout,
    AbortController,
    Request,
    Response,
    Headers,
    FormData,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    fetch: async () => ({ json: async () => ({}), text: async () => '' }),
    module: { exports: {} },
    exports: {},
    Buffer,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  };

  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.require = (specifier) => {
    if (mockModules.has(specifier)) {
      return mockModules.get(specifier);
    }
    return baseRequire(specifier);
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(transformedRouteTs, context, { filename: routeFilename });

  return { context, infoLogs };
}

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

test('verifyOutput logs a success message when Grok approves an article', async () => {
  const { context, infoLogs } = createVerificationSandbox();

  vm.runInContext(
    `
      runGrokVerificationWithRetry = async () => JSON.stringify({ discrepancies: [] });
      runOpenAIVerificationWithTimeout = async () => { throw new Error('OpenAI should not run'); };
    `,
    context
  );

  const result = await context.verifyOutput('<p>Verified</p>', [{ url: 'https://example.com' }]);

  assert.strictEqual(result.isAccurate, true);
  assert.strictEqual(result.discrepancies.length, 0);
  assert.strictEqual(result.themeCoverageIssue, null);
  assert(
    infoLogs.some((entry) => entry.includes('GROK_VERIFICATION_SUCCEEDED')),
    'Expected Grok verification success to emit a console.info message.'
  );
});

test('verifyOutput does not log Grok success when falling back to OpenAI', async () => {
  const { context, infoLogs } = createVerificationSandbox({ OPENAI_API_KEY: 'openai-key' });

  vm.runInContext(
    `
      runGrokVerificationWithRetry = async () => { throw new Error('primary failure'); };
      runOpenAIVerificationWithTimeout = async () => JSON.stringify({ discrepancies: [] });
    `,
    context
  );

  const result = await context.verifyOutput('<p>Fallback</p>', [{ url: 'https://example.com' }]);

  assert.strictEqual(result.isAccurate, true);
  assert.strictEqual(result.discrepancies.length, 0);
  assert(
    !infoLogs.some((entry) => entry.includes('GROK_VERIFICATION_SUCCEEDED')),
    'Grok success log should not fire when verification falls back to OpenAI.'
  );
});

test('verifyOutput does not log Grok success when discrepancies are reported', async () => {
  const { context, infoLogs } = createVerificationSandbox();

  vm.runInContext(
    `
      runGrokVerificationWithRetry = async () => JSON.stringify({
        discrepancies: [
          { description: 'Mismatch detected', severity: 'critical' }
        ],
      });
      runOpenAIVerificationWithTimeout = async () => { throw new Error('OpenAI should not run'); };
    `,
    context
  );

  const result = await context.verifyOutput('<p>Mismatch</p>', [{ url: 'https://example.com' }]);

  assert.strictEqual(result.isAccurate, false);
  assert(
    !infoLogs.some((entry) => entry.includes('GROK_VERIFICATION_SUCCEEDED')),
    'Grok success log should only fire when no discrepancies are reported.'
  );
});
