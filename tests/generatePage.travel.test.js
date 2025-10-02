import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, before, afterEach } from 'node:test';
import Module from 'module';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createRequire, Module: CJSModule, _nodeModulePaths } = Module;
const require = createRequire(import.meta.url);
const originalFetch = global.fetch;

let GeneratePage;
let routerStub;

async function loadGeneratePage() {
  const result = await esbuild.build({
    entryPoints: ['src/app/generate/page.tsx'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    write: false,
    jsx: 'automatic',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    define: {
      'process.env.NODE_ENV': '"test"',
      'process.env.NEXT_PUBLIC_SUPABASE_URL': '""',
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '""',
    },
    external: ['next/navigation', '../../lib/supabase', 'react', 'react/jsx-runtime', 'react-dom'],
  });

  const code = result.outputFiles[0].text;
  const filename = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '.generated-generate-page.cjs'
  );
  const mod = new CJSModule(filename);
  mod.filename = filename;
  mod.paths = _nodeModulePaths(path.dirname(filename));
  routerStub = { push: () => {} };
  const supabaseStub = { supabase: { auth: { signOut: async () => {} } } };
  mod.require = (specifier) => {
    if (specifier === 'next/navigation' || specifier.startsWith('next/navigation')) {
      return { useRouter: () => routerStub };
    }
    if (specifier.includes('supabase')) {
      return supabaseStub;
    }
    if (specifier === 'react') {
      return require('react');
    }
    if (specifier === 'react/jsx-runtime') {
      return require('react/jsx-runtime');
    }
    return require(specifier);
  };
  mod._compile(code, filename);
  return mod.exports.default || mod.exports;
}

before(async () => {
  GeneratePage = await loadGeneratePage();
});

afterEach(() => {
  cleanup();
  if (typeof global.window !== 'undefined') {
    global.window.close?.();
  }
  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.HTMLElement;
  delete global.localStorage;
  delete global.MutationObserver;
  delete global.Node;
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
  delete global.alert;
  global.fetch = originalFetch;
});

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.MutationObserver = dom.window.MutationObserver;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.alert = () => {};
  return dom;
}

test('travel selector toggles and travel state is sent with payload', async () => {
  const dom = setupDom();
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === 'content-type' ? 'application/json' : null;
        },
      },
      json: async () => ({ content: '<p>ok</p>' }),
    };
  };

  const user = userEvent.setup({ document: dom.window.document });
  const { getByLabelText, queryByLabelText, getByRole } = render(
    React.createElement(GeneratePage)
  );

  const articleTypeSelect = getByLabelText('Article Type');
  assert.equal(queryByLabelText('Travel destination'), null);

  await user.selectOptions(articleTypeSelect, 'Travel article');
  const travelSelect = getByLabelText('Travel destination');
  assert.ok(travelSelect);
  assert.equal(travelSelect.value, 'OR');

  await user.selectOptions(travelSelect, 'CA');
  assert.equal(travelSelect.value, 'CA');

  await user.selectOptions(articleTypeSelect, 'Blog post');
  assert.equal(queryByLabelText('Travel destination'), null);

  await user.selectOptions(articleTypeSelect, 'Travel article');
  const travelSelectAgain = getByLabelText('Travel destination');
  assert.equal(travelSelectAgain.value, 'CA');

  const titleInput = getByLabelText('Title');
  await user.type(titleInput, 'Exploring the West Coast');

  const generateButton = getByRole('button', { name: 'Generate & Edit' });
  await user.click(generateButton);

  await waitFor(() => {
    assert.equal(fetchCalls.length, 1);
  });

  const payload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(payload.articleType, 'Travel article');
  assert.equal(payload.travelState, 'CA');

  dom.window.close();
});
