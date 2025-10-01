export type PresetCategory = {
  id: string;
  label: string;
  children?: readonly PresetCategory[];
};

const MORNING_OVERVIEW_CATEGORIES: readonly PresetCategory[] = [
  {
    id: 'global-affairs',
    label: 'Global Affairs & Security',
    children: [
      { id: 'geopolitics', label: 'Overnight Geopolitics' },
      { id: 'conflicts', label: 'Conflicts & Flashpoints' },
      { id: 'diplomacy', label: 'Diplomacy & Alliances' },
    ],
  },
  {
    id: 'us-policy',
    label: 'U.S. Policy & Politics',
    children: [
      { id: 'white-house', label: 'White House & Administration' },
      { id: 'congress', label: 'Congress & Regulation' },
      { id: 'elections', label: 'Elections & Campaigns' },
    ],
  },
  {
    id: 'market-moves',
    label: 'Market Moves',
    children: [
      { id: 'equities', label: 'Equities & Futures' },
      { id: 'fixed-income', label: 'Fixed Income & Rates' },
      { id: 'commodities', label: 'Commodities & Energy' },
      { id: 'currencies', label: 'Currencies & Crypto' },
    ],
  },
  {
    id: 'corporate-tech',
    label: 'Corporate & Tech',
    children: [
      { id: 'earnings', label: 'Earnings & Deals' },
      { id: 'big-tech', label: 'Big Tech & Innovation' },
      { id: 'startups', label: 'Startups & Venture' },
    ],
  },
  {
    id: 'science-health',
    label: 'Science, Health & Climate',
    children: [
      { id: 'public-health', label: 'Medical & Public Health' },
      { id: 'climate', label: 'Climate & Environment' },
      { id: 'space', label: 'Space & Advanced Research' },
    ],
  },
  {
    id: 'culture-trends',
    label: 'Culture & Trends',
    children: [
      { id: 'media', label: 'Media & Entertainment' },
      { id: 'sports', label: 'Sports Business' },
      { id: 'lifestyle', label: 'Lifestyle & Travel' },
    ],
  },
];

export const HEADLINE_SITES = {
  morningOverview: {
    name: 'Morning Overview',
    instructions:
      'Surface the biggest overnight developments in global news, markets, and policy with a concise, pre-market tone. Prioritize authoritative sources, highlight why each story matters this morning, and favor items published within the last 12 hours.',
    country: 'us',
    keywords: [
      'Alien Technology',
      'Ancient Civilizations',
      'Lost Cities',
      'Mars Discoveries',
      'NASA Discoveries',
      'Astronomy Breakthroughs',
      'UFO Sightings',
      'Interstellar Objects',
      'Time Travel Claims',
      'Military Technology',
      'Energy Breakthroughs',
      'Smartphone Alternatives',
      'Hidden Structures',
      'Religious Artifacts',
      'Mysterious Phenomena',
      'Underground Cities',
      'Truck Reliability',
      'SUV Longevity',
      'Car Bans & Recalls',
      'Engine Failures',
    ] as const,
    rssFeeds: [
      'https://www.slashgear.com/feed/',
      'https://modernengineeringmarvels.com/feed/',
      'https://techcrunch.com/feed/',
      'https://www.hotcars.com/feed/',
      'https://interestingengineering.com/feed',
      'https://www.zmescience.com/feed/',
      'https://dailygalaxy.com/feed/',
    ] as const,
    categories: MORNING_OVERVIEW_CATEGORIES,
  },
  dailyOverview: {
    name: 'The Daily Overview',
    instructions:
      'Compile a balanced, mid-day digest that blends world affairs, U.S. policy, business trends, science breakthroughs, and notable culture stories. Keep the tone analytical yet approachable and emphasize takeaways a curious professional would want to discuss later in the day.',
    country: 'us',
    categories: [],
  },
  flexibleFridge: {
    name: 'The Flexible Fridge',
    instructions:
      'Find inventive food, grocery, and sustainability reporting that helps home cooks stretch ingredients, reduce waste, and plan flexible meals. Prioritize service journalism with actionable tips, seasonal produce spotlights, and clever storage or substitution ideas.',
    country: 'us',
    categories: [],
  },
  californiaAdventure: {
    name: 'California is for Adventure',
    instructions:
      'Curate outdoor travel inspiration across California, from coastal escapes to desert and mountain adventures. Feature hikes and road-trip ideas, scenic state and national parks, and local guides that highlight responsible recreation and hidden-gem communities.',
    country: 'us',
    categories: [],
  },
  oregonAdventure: {
    name: 'Oregon is for Adventure',
    instructions:
      'Highlight Pacific Northwest explorations throughout Oregon, including forest trails, coastline retreats, volcanic landscapes, and craft-forward towns. Seek stories that mix itineraries, gear tips, and conservation-minded advice for year-round adventurers.',
    country: 'us',
    categories: [],
  },
  washingtonAdventure: {
    name: 'Washington is for Adventure',
    instructions:
      'Spotlight Washington state adventures with coverage of national parks, islands, alpine routes, and urban gateways to the outdoors. Emphasize weekend-friendly itineraries, weather-aware planning, and guides that celebrate local experts and tribal lands.',
    country: 'us',
    categories: [],
  },
} satisfies Record<
  string,
  {
    name: string;
    instructions: string;
    country: 'us';
    keywords?: readonly string[];
    rssFeeds?: readonly string[];
    categories?: readonly PresetCategory[];
  }
>;

export type HeadlineSiteKey = keyof typeof HEADLINE_SITES;

export type { PresetCategory };
