import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const grokPath = new URL('../src/lib/grok.ts', import.meta.url);
const grokSource = fs.readFileSync(grokPath, 'utf8');

test('DEFAULT_GROK_MODEL falls back to grok-4-fast', () => {
  assert(
    /process\.env\.GROK_VERIFICATION_MODEL\?\.trim\(\) \|\| 'grok-4-fast'/.test(
      grokSource
    ),
    'Expected DEFAULT_GROK_MODEL to default to grok-4-fast when unset.'
  );
});

test('DEFAULT_GROK_OUTLINE_MODEL falls back to DEFAULT_GROK_MODEL', () => {
  assert(
    /export const DEFAULT_GROK_OUTLINE_MODEL =\s*\n\s*process\.env\.GROK_OUTLINE_MODEL\?\.trim\(\) \|\| DEFAULT_GROK_MODEL/.test(
      grokSource
    ),
    'Expected DEFAULT_GROK_OUTLINE_MODEL to reuse DEFAULT_GROK_MODEL when unset.'
  );
});
