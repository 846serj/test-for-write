import type { TravelPreset } from './travelPresets';

export type TravelThemeFact = {
  title: string;
  summary: string;
  url: string;
  publishedAt?: string;
};

export type TravelThemeFactsParams = {
  themeLabel?: string | null;
  destinationName?: string | null;
  travelPreset?: TravelPreset | null;
};

type TravelThemeFactsRecord = {
  theme: string;
  destinations?: string[];
  entries: Array<TravelThemeFact & { sources?: string[] }>;
};

const INTERNAL_TRAVEL_THEME_FACTS: TravelThemeFactsRecord[] = [
  {
    theme: 'bigfoot lovers',
    destinations: ['pacific northwest', 'oregon', 'washington'],
    entries: [
      {
        title: 'Bigfoot Field Researchers Organization sighting map',
        summary:
          'The BFRO catalogues more than 4,000 Class A and B sighting reports across North America, with Washington leading the tally.',
        url: 'https://www.bfro.net/GDB/state_listing.asp?state=WA',
      },
      {
        title: 'North American Bigfoot Center in Boring, Oregon',
        summary:
          'The museum’s exhibits showcase plaster casts, eyewitness interviews, and expedition gear curated by researcher Cliff Barackman.',
        url: 'https://northamericanbigfootcenter.com/',
      },
    ],
  },
  {
    theme: 'ufo enthusiasts',
    destinations: ['nevada', 'new mexico', 'arizona'],
    entries: [
      {
        title: 'National Atomic Testing Museum’s Area 51 exhibit',
        summary:
          'Las Vegas’ Smithsonian-affiliated museum devotes a permanent gallery to Area 51 lore with declassified documents and pilot testimonies.',
        url: 'https://nationalatomictestingmuseum.org/area-51/',
      },
      {
        title: 'International UFO Museum and Research Center in Roswell',
        summary:
          'Founded in 1991, the Roswell museum archives military affidavits, crash debris replicas, and a timeline of global sightings.',
        url: 'https://www.roswellufomuseum.com/',
      },
    ],
  },
  {
    theme: 'ghost hunters',
    destinations: ['louisiana', 'savannah', 'south carolina', 'new orleans'],
    entries: [
      {
        title: 'New Orleans’ LaLaurie Mansion lore',
        summary:
          'The Royal Street mansion is cited in countless ghost tours for reports of apparitions tied to Madame Delphine LaLaurie’s 1830s atrocities.',
        url: 'https://ghostcitytours.com/new-orleans/ghost-stories/lalaurie-mansion/',
      },
      {
        title: 'Sorrel-Weed House investigations in Savannah',
        summary:
          'Featured on Ghost Hunters and Ghost Adventures, the 1840s estate hosts nightly paranormal investigations documenting EVPs and shadow figures.',
        url: 'https://sorrelweedhouse.com/ghost-hunting/',
      },
    ],
  },
];

const normalize = (value: string | null | undefined): string => {
  return value ? value.trim().toLowerCase() : '';
};

const destinationMatches = (
  recordDestinations: string[] | undefined,
  normalizedDestination: string
): boolean => {
  if (!recordDestinations || recordDestinations.length === 0) {
    return true;
  }
  if (!normalizedDestination) {
    return false;
  }
  return recordDestinations.some(
    (destination) => normalize(destination) === normalizedDestination
  );
};

export async function fetchTravelThemeFacts(
  params: TravelThemeFactsParams
): Promise<TravelThemeFact[]> {
  const normalizedTheme = normalize(params.themeLabel);
  if (!normalizedTheme) {
    return [];
  }

  const normalizedDestination = normalize(params.destinationName);
  const matches: TravelThemeFact[] = [];

  for (const record of INTERNAL_TRAVEL_THEME_FACTS) {
    if (normalize(record.theme) !== normalizedTheme) {
      continue;
    }

    if (!destinationMatches(record.destinations, normalizedDestination)) {
      continue;
    }

    for (const entry of record.entries) {
      if (!entry.url) {
        continue;
      }
      matches.push({ ...entry });
    }
  }

  if (matches.length) {
    return matches;
  }

  const fallbackRecord = INTERNAL_TRAVEL_THEME_FACTS.find(
    (record) => normalize(record.theme) === normalizedTheme
  );
  if (!fallbackRecord) {
    return [];
  }

  return fallbackRecord.entries.filter((entry) => Boolean(entry.url));
}

export default fetchTravelThemeFacts;
