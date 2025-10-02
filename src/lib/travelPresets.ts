import { HEADLINE_SITES, type HeadlineSiteKey } from '../constants/headlineSites';

type TravelPresetOverrides = Partial<{
  stateName: string;
  keywords: readonly string[];
  rssFeeds: readonly string[];
  instructions: readonly string[];
  siteKey: HeadlineSiteKey | null;
}>;

export type TravelPreset = {
  state: string;
  stateName: string;
  keywords: string[];
  rssFeeds: string[];
  instructions: string[];
  siteKey: HeadlineSiteKey | null;
};

export type TravelPresetFetcher = (
  state: string
) => Promise<TravelPresetOverrides | null>;

type GetTravelPresetOptions = {
  fetcher?: TravelPresetFetcher | null;
  headlineSites?: typeof HEADLINE_SITES;
};

const STATE_NAME_MAP: Record<string, string> = {
  al: 'Alabama',
  ak: 'Alaska',
  az: 'Arizona',
  ar: 'Arkansas',
  ca: 'California',
  co: 'Colorado',
  ct: 'Connecticut',
  de: 'Delaware',
  fl: 'Florida',
  ga: 'Georgia',
  hi: 'Hawaii',
  ia: 'Iowa',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  ma: 'Massachusetts',
  md: 'Maryland',
  me: 'Maine',
  mi: 'Michigan',
  mn: 'Minnesota',
  mo: 'Missouri',
  ms: 'Mississippi',
  mt: 'Montana',
  nc: 'North Carolina',
  nd: 'North Dakota',
  ne: 'Nebraska',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  nv: 'Nevada',
  ny: 'New York',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  va: 'Virginia',
  vt: 'Vermont',
  wa: 'Washington',
  wi: 'Wisconsin',
  wv: 'West Virginia',
  wy: 'Wyoming',
};

const STATE_PRESET_OVERRIDES: Record<
  string,
  {
    siteKey?: HeadlineSiteKey;
    instructions?: string[];
  }
> = {
  or: {
    siteKey: 'oregonAdventure',
    instructions: [
      'Spotlight scenic drives, waterfall hikes, and outdoor adventures spanning the Oregon Coast, Cascades, and high desert.',
      'Recommend locally-owned lodging and standout dining options in Oregon towns mentioned in the sources.',
      'Offer itinerary tips that balance seasonal weather, road trip pacing, and regional highlights around Oregon.',
    ],
  },
  ca: {
    siteKey: 'californiaAdventure',
  },
  wa: {
    siteKey: 'washingtonAdventure',
  },
};

function buildDefaultInstructions(stateName: string): string[] {
  const label = stateName || 'the destination';
  const displayLabel =
    label === 'the destination' ? label : label.replace(/\s+/g, ' ').trim();
  return [
    `Spotlight must-see attractions, parks, and outdoor experiences throughout ${displayLabel}.`,
    `Blend lodging and dining recommendations tailored to different traveler budgets in ${displayLabel}.`,
    `Share itinerary-friendly tips—seasonal timing, route suggestions, and pacing guidance—for exploring ${displayLabel}.`,
  ];
}

export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

export function buildDefaultTravelPreset(
  stateInput: string | null | undefined,
  options: GetTravelPresetOptions = {}
): TravelPreset {
  const sites = options.headlineSites ?? HEADLINE_SITES;
  const normalizedState =
    typeof stateInput === 'string' ? stateInput.trim().toLowerCase() : '';
  const stateName = normalizedState
    ? STATE_NAME_MAP[normalizedState] ?? normalizedState.toUpperCase()
    : 'the destination';
  const override = STATE_PRESET_OVERRIDES[normalizedState];
  const siteKey = override?.siteKey ?? null;
  const site = siteKey ? sites[siteKey] : undefined;
  const defaultKeywords = Array.isArray(site?.keywords)
    ? dedupeStrings(site!.keywords)
    : [];
  const defaultFeeds = Array.isArray(site?.rssFeeds)
    ? dedupeStrings(site!.rssFeeds)
    : [];
  const instructions = override?.instructions
    ? dedupeStrings(override.instructions)
    : buildDefaultInstructions(stateName);

  return {
    state: normalizedState,
    stateName,
    keywords: defaultKeywords,
    rssFeeds: defaultFeeds,
    instructions,
    siteKey,
  };
}

export function mergeTravelPresetDetails(
  base: TravelPreset,
  overrides?: TravelPresetOverrides | null
): TravelPreset {
  if (!overrides) {
    return base;
  }

  const nextKeywords = Array.isArray(overrides.keywords)
    ? dedupeStrings([...overrides.keywords, ...base.keywords])
    : base.keywords;
  const nextFeeds = Array.isArray(overrides.rssFeeds)
    ? dedupeStrings([...overrides.rssFeeds, ...base.rssFeeds])
    : base.rssFeeds;
  const nextInstructions = Array.isArray(overrides.instructions)
    ? dedupeStrings([...overrides.instructions, ...base.instructions])
    : base.instructions;
  const nextStateName =
    typeof overrides.stateName === 'string' && overrides.stateName.trim()
      ? overrides.stateName.trim()
      : base.stateName;
  const overrideSiteKey = overrides.siteKey;

  return {
    state: base.state,
    stateName: nextStateName,
    keywords: nextKeywords,
    rssFeeds: nextFeeds,
    instructions: nextInstructions,
    siteKey:
      typeof overrideSiteKey === 'string' && overrideSiteKey
        ? (overrideSiteKey as HeadlineSiteKey)
        : overrideSiteKey === null
        ? null
        : base.siteKey,
  };
}

async function fetchPresetFromSupabase(
  state: string
): Promise<TravelPresetOverrides | null> {
  if (!state) {
    return null;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  try {
    const { supabaseAdmin } = await import('./supabaseAdmin');
    const { data, error } = await supabaseAdmin
      .from('travel_presets')
      .select('state_name, keywords, rss_feeds, instructions, site_key')
      .eq('state', state)
      .maybeSingle();

    if (error) {
      console.error('[travelPresets] Supabase error:', error);
      return null;
    }

    if (!data) {
      return null;
    }

    const overrides: TravelPresetOverrides = {};
    if (typeof data.state_name === 'string' && data.state_name.trim()) {
      overrides.stateName = data.state_name.trim();
    }

    if (Array.isArray(data.keywords)) {
      overrides.keywords = data.keywords;
    }

    if (Array.isArray(data.rss_feeds)) {
      overrides.rssFeeds = data.rss_feeds;
    }

    if (Array.isArray(data.instructions)) {
      overrides.instructions = data.instructions;
    }

    if (typeof data.site_key === 'string' && data.site_key.trim()) {
      overrides.siteKey = data.site_key.trim() as HeadlineSiteKey;
    } else if (data.site_key === null) {
      overrides.siteKey = null;
    }

    return overrides;
  } catch (error) {
    console.error('[travelPresets] Failed to load Supabase preset:', error);
    return null;
  }
}

export async function getTravelPreset(
  stateInput: string | null | undefined,
  options: GetTravelPresetOptions = {}
): Promise<TravelPreset> {
  const base = buildDefaultTravelPreset(stateInput, options);
  const fetcher = options.fetcher ?? fetchPresetFromSupabase;

  if (!fetcher) {
    return base;
  }

  try {
    const overrides = await fetcher(base.state);
    return mergeTravelPresetDetails(base, overrides);
  } catch (error) {
    console.error('[travelPresets] Failed to resolve overrides:', error);
    return base;
  }
}

export const __TESTING__ = {
  STATE_NAME_MAP,
  STATE_PRESET_OVERRIDES,
  buildDefaultInstructions,
  fetchPresetFromSupabase,
};
