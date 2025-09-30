export const HEADLINE_SITES = {
  morningOverview: {
    name: 'Morning Overview',
    instructions:
      'Surface the biggest overnight developments in global news, markets, and policy with a concise, pre-market tone. Prioritize authoritative sources, highlight why each story matters this morning, and favor items published within the last 12 hours.',
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
    rssFeeds: ['https://www.slashgear.com/feed/'],
  },
  dailyOverview: {
    name: 'The Daily Overview',
    instructions:
      'Compile a balanced, mid-day digest that blends world affairs, U.S. policy, business trends, science breakthroughs, and notable culture stories. Keep the tone analytical yet approachable and emphasize takeaways a curious professional would want to discuss later in the day.',
  },
  flexibleFridge: {
    name: 'The Flexible Fridge',
    instructions:
      'Find inventive food, grocery, and sustainability reporting that helps home cooks stretch ingredients, reduce waste, and plan flexible meals. Prioritize service journalism with actionable tips, seasonal produce spotlights, and clever storage or substitution ideas.',
  },
  californiaAdventure: {
    name: 'California is for Adventure',
    instructions:
      'Curate outdoor travel inspiration across California, from coastal escapes to desert and mountain adventures. Feature hikes and road-trip ideas, scenic state and national parks, and local guides that highlight responsible recreation and hidden-gem communities.',
  },
  oregonAdventure: {
    name: 'Oregon is for Adventure',
    instructions:
      'Highlight Pacific Northwest explorations throughout Oregon, including forest trails, coastline retreats, volcanic landscapes, and craft-forward towns. Seek stories that mix itineraries, gear tips, and conservation-minded advice for year-round adventurers.',
  },
  washingtonAdventure: {
    name: 'Washington is for Adventure',
    instructions:
      'Spotlight Washington state adventures with coverage of national parks, islands, alpine routes, and urban gateways to the outdoors. Emphasize weekend-friendly itineraries, weather-aware planning, and guides that celebrate local experts and tribal lands.',
  },
} satisfies Record<
  string,
  {
    name: string;
    instructions: string;
    keywords?: readonly string[];
    rssFeeds?: readonly string[];
  }
>;

export type HeadlineSiteKey = keyof typeof HEADLINE_SITES;
