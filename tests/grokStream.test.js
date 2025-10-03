import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { pathToFileURL } from 'url';
import { transformSync } from 'esbuild';

const grokModulePath = new URL('../src/lib/grok.ts', import.meta.url);

async function loadGrokModule() {
  const source = fs.readFileSync(grokModulePath, 'utf8');
  const { code } = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-test-'));
  const outFile = path.join(tempDir, 'grok.mjs');
  fs.writeFileSync(outFile, code, 'utf8');

  return import(pathToFileURL(outFile).href);
}

test('runChatCompletion aggregates streamed Grok responses', async () => {
  const { runChatCompletion } = await loadGrokModule();
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const originalFetch = globalThis.fetch;
  process.env.GROK_API_KEY = 'test-key';
  const fetchCalls = [];

  globalThis.fetch = async (_input, init) => {
    fetchCalls.push(init);
    return new Response(stream, { status: 200 });
  };

  try {
    const response = await runChatCompletion({
      model: 'grok-test',
      messages: [{ role: 'user', content: 'Hello?' }],
      stream: true,
    });

    assert.strictEqual(fetchCalls.length, 1, 'Expected a single fetch invocation.');
    const requestBody = fetchCalls[0]?.body;
    assert.strictEqual(typeof requestBody, 'string', 'Request payload should be serialized to JSON.');
    const parsedBody = JSON.parse(requestBody);
    assert.strictEqual(parsedBody.stream, true, 'Streaming flag should be forwarded to Grok.');

    const choice = response.choices[0];
    assert(choice, 'Streaming response should contain at least one choice.');
    assert(choice.message, 'Streaming response choice should include a message object.');
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello world');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
