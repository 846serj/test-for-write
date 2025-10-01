export const HEADLINE_SITES = {
  morningOverview: {
    name: 'Morning Overview',
    country: 'us',
    keywords: [
      'Alien Tech',
      'Ancient Civilizations',
      'Lost Cities',
      'Mars Discoveries',
      'NASA Discoveries',
      'Astronomy Breakthroughs',
      'UFO Reports',
      'Interstellar Objects',
      'SpaceX Updates',
      'Tesla Tech',
      'Military Tech',
      'Energy Breakthroughs',
      'Smartphones',
      'Religious Artifacts',
      'Mysterious Phenomena',
      'Underground Cities',
      'Truck Reliability',
      'SUV Longevity',
      'Artificial Intelligence',
      'Aviation Tech',
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
  },
  dailyOverview: {
    name: 'The Daily Overview',
    country: 'us',
    keywords: [
      'Fed Rates',
      'Stimulus Checks',
      'Social Security',
      'Retirement Planning',
      'Economic Collapse',
      'Stock Market',
      'Investments',
      'Net Worth',
      'Wealth Building',
      'Passive Income',
      'Frugal Habits',
      'Budgeting',
      'Cars',
      'Used Cars',
      'Electric Vehicles',
      'Housing Market',
      'Affordable Living',
      'Cheap Land',
      'Generational Trends',
      'Remote Jobs',
    ] as const,
  },
  flexibleFridge: {
    name: 'The Flexible Fridge',
    country: 'us',
  },
  californiaAdventure: {
    name: 'California is for Adventure',
    country: 'us',
  },
  oregonAdventure: {
    name: 'Oregon is for Adventure',
    country: 'us',
    keywords: [
      'Oregon Coastline',
      'Columbia River Gorge',
      'Painted Hills Oregon',
      'Crater Lake National Park',
      'Oregon waterfalls',
      'Oregon hiking trails',
      'Oregon road trips',
      'Oregon camping spots',
      'Oregon hot springs',
      'Oregon skiing & snowboarding',
      'Portland food scene',
      'Bend Oregon adventures',
      'Eugene arts & culture',
      'Oregon small towns',
      'Oregon wine country',
      'Oregon travel guide',
      'Family travel Oregon',
      'Oregon hidden gems',
      'Scenic byways Oregon',
      'Oregon seasonal festivals',
    ] as const,
  },
  washingtonAdventure: {
    name: 'Washington is for Adventure',
    country: 'us',
  },
} satisfies Record<
  string,
  {
    name: string;
    country: 'us';
    keywords?: readonly string[];
    rssFeeds?: readonly string[];
  }
>;

export type HeadlineSiteKey = keyof typeof HEADLINE_SITES;

