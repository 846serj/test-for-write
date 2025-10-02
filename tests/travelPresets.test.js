import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const helperPath = new URL('../src/lib/travelPresets.ts', import.meta.url);
const helperSource = fs.readFileSync(helperPath, 'utf8');

const helperSnippet = `
const HEADLINE_SITES = {
  oregonAdventure: {
    name: 'Oregon is for Adventure',
    country: 'us',
    keywords: ['Oregon travel itinerary', 'Oregon coast weekend itinerary'],
    rssFeeds: ['https://traveloregon.com/feed'],
  },
  californiaAdventure: {
    name: 'California is for Adventure',
    country: 'us',
    keywords: ['California travel'],
    rssFeeds: ['https://california.com/feed'],
  },
  washingtonAdventure: {
    name: 'Washington is for Adventure',
    country: 'us',
    keywords: [],
    rssFeeds: [],
  },
};
type HeadlineSiteKey = keyof typeof HEADLINE_SITES;
${helperSource
  .replace(
    /import { HEADLINE_SITES, type HeadlineSiteKey } from '\.\.\/constants\/headlineSites';\n/,
    ''
  )
  .replace(/import\s+type\s+[^;]+;\n/g, '')}
export {
  dedupeStrings,
  buildDefaultTravelPreset,
  mergeTravelPresetDetails,
  getTravelPreset,
  __TESTING__,
};
`;

const helperModuleUrl =
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(helperSnippet, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText,
    'utf8'
  ).toString('base64');

const {
  dedupeStrings,
  buildDefaultTravelPreset,
  mergeTravelPresetDetails,
  getTravelPreset,
  __TESTING__,
} = await import(helperModuleUrl);

const apiPath = new URL('../src/app/api/travel-presets/route.ts', import.meta.url);
const apiSource = fs.readFileSync(apiPath, 'utf8');

const apiSnippet = `
let presetResult = null;
let lastRequestedState = null;
function setPresetResult(result) { presetResult = result; }
function getLastRequestedState() { return lastRequestedState; }
const NextResponse = {
  json(payload, init = {}) {
    const status = init.status ?? 200;
    return {
      status,
      async json() {
        return payload;
      },
    };
  },
};
async function getTravelPreset(state) {
  lastRequestedState = state;
  if (presetResult) {
    return presetResult;
  }
  return {
    state: state ? state.trim().toLowerCase() : '',
    stateName: state ? state.toUpperCase() : 'the destination',
    keywords: [],
    rssFeeds: [],
    instructions: [],
    siteKey: null,
  };
}
${apiSource.replace(
  /import { getTravelPreset } from '\.\.\/\.\.\/lib\/travelPresets';\n/,
  ''
)}
export { handleTravelPresetRequest, GET, setPresetResult, getLastRequestedState };
`;

const apiModuleUrl =
  'data:text/javascript;base64,' +
  Buffer.from(
    ts.transpileModule(apiSnippet, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText,
    'utf8'
  ).toString('base64');

const {
  handleTravelPresetRequest,
  GET: travelPresetGet,
  setPresetResult,
  getLastRequestedState,
} = await import(apiModuleUrl);

test('getTravelPreset returns seeded defaults for Oregon presets', async () => {
  const preset = await getTravelPreset('or');
  assert.strictEqual(preset.state, 'or');
  assert.strictEqual(preset.stateName, 'Oregon');
  assert.deepStrictEqual(preset.keywords, [
    'Oregon travel itinerary',
    'Oregon coast weekend itinerary',
  ]);
  assert.deepStrictEqual(preset.rssFeeds, ['https://traveloregon.com/feed']);
  assert(
    preset.instructions.some((item) =>
      item.includes('scenic drives') && item.includes('Oregon')
    ),
    'Preset instructions should include scenic Oregon guidance.'
  );
});

test('mergeTravelPresetDetails dedupes overrides while preserving defaults', () => {
  const base = buildDefaultTravelPreset('ca');
  const merged = mergeTravelPresetDetails(base, {
    stateName: 'California Dreaming',
    keywords: ['California travel', 'Wine country escapes'],
    rssFeeds: ['https://travelweekly.com/feed', 'https://california.com/feed'],
    instructions: [
      'Add wine country itineraries.',
      'Add wine country itineraries.',
    ],
    siteKey: null,
  });

  assert.strictEqual(merged.stateName, 'California Dreaming');
  assert.deepStrictEqual(merged.keywords, [
    'California travel',
    'Wine country escapes',
  ]);
  assert.deepStrictEqual(merged.rssFeeds, [
    'https://travelweekly.com/feed',
    'https://california.com/feed',
  ]);
  assert.deepStrictEqual(merged.instructions, [
    'Add wine country itineraries.',
    ...__TESTING__.buildDefaultInstructions('California'),
  ]);
  assert.strictEqual(merged.siteKey, null);
});

test('getTravelPreset merges overrides from a custom fetcher', async () => {
  const preset = await getTravelPreset('wa', {
    fetcher: async () => ({
      keywords: ['Washington waterfalls', 'Travel guide'],
      instructions: ['Add ferry schedule tips.'],
      rssFeeds: ['https://washington.com/feed'],
    }),
  });

  assert.strictEqual(preset.state, 'wa');
  assert(preset.keywords.includes('Washington waterfalls'));
  assert.strictEqual(
    preset.keywords.filter((item) => item.toLowerCase() === 'travel guide').length,
    1
  );
  assert(preset.instructions.some((item) => item.includes('ferry schedule')));
  assert(preset.rssFeeds.includes('https://washington.com/feed'));
});

test('handleTravelPresetRequest surfaces the resolved preset and caches the state lookup', async () => {
  const presetPayload = {
    state: 'ca',
    stateName: 'California',
    keywords: ['California travel'],
    rssFeeds: [],
    instructions: ['Focus on national parks.'],
    siteKey: 'californiaAdventure',
  };
  setPresetResult(presetPayload);
  const response = await handleTravelPresetRequest('ca');
  assert.deepStrictEqual(response, { preset: presetPayload });
  assert.strictEqual(getLastRequestedState(), 'ca');
});

test('GET handler returns JSON with the preset payload', async () => {
  const presetPayload = {
    state: 'ny',
    stateName: 'New York',
    keywords: ['New York travel'],
    rssFeeds: ['https://nytravel.com/feed'],
    instructions: ['Explore upstate escapes.'],
    siteKey: null,
  };
  setPresetResult(presetPayload);
  const request = new Request('https://example.com/api/travel-presets?state=ny');
  const response = await travelPresetGet(request);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body, { preset: presetPayload });
  assert.strictEqual(getLastRequestedState(), 'ny');
});
