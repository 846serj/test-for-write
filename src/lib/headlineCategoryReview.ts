import type { PresetCategory } from '../constants/headlineSites';

export type ReviewableHeadline = {
  title?: string;
  description?: string;
  source?: string;
};

export type HeadlineCategoryReviewResult = {
  index: number;
  status: 'matched' | 'unmatched';
  categoryId: string | null;
  categoryLabel: string | null;
  matchedTerms: string[];
  score: number;
};

type FlattenedCategory = {
  id: string;
  label: string;
  depth: number;
  phrases: string[];
  tokens: string[];
};

const CATEGORY_KEYWORD_OVERRIDES: Record<string, readonly string[]> = {
  'global-affairs': [
    'geopolitics',
    'foreign policy',
    'international relations',
    'security',
    'defense',
    'nato',
    'war',
    'military',
  ],
  geopolitics: ['foreign affairs', 'state visit', 'global politics'],
  conflicts: ['war', 'battle', 'offensive', 'strike', 'attack', 'clash'],
  diplomacy: ['talks', 'summit', 'negotiations', 'diplomatic', 'treaty'],
  'us-policy': [
    'washington',
    'congress',
    'white house',
    'federal government',
    'policy',
    'regulation',
  ],
  'market-moves': [
    'markets',
    'stocks',
    'bonds',
    'treasury',
    'investors',
    'dow jones',
    'nasdaq',
    's&p 500',
  ],
  equities: ['stocks', 'shares', 'equity', 'stock market'],
  'fixed-income': ['bonds', 'treasury', 'yields', 'fixed income'],
  commodities: ['commodity', 'oil', 'gold', 'energy', 'natural gas', 'metals'],
  currencies: ['currency', 'forex', 'dollar', 'euro', 'crypto', 'bitcoin'],
  'corporate-tech': ['corporate', 'business', 'technology', 'startup'],
  earnings: ['earnings', 'profit', 'quarter', 'merger', 'acquisition', 'deal'],
  'big-tech': ['apple', 'google', 'amazon', 'microsoft', 'meta', 'ai'],
  startups: ['startup', 'venture', 'funding', 'seed', 'series a', 'series b'],
  'science-health': ['science', 'health', 'medical', 'climate', 'research'],
  'public-health': ['health', 'disease', 'vaccine', 'hospital', 'cdc', 'who'],
  climate: ['climate', 'emissions', 'weather', 'extreme heat', 'global warming'],
  space: ['space', 'nasa', 'spacex', 'astronaut', 'launch', 'satellite'],
  'culture-trends': ['culture', 'entertainment', 'sports', 'lifestyle'],
  media: ['media', 'streaming', 'film', 'television', 'tv', 'hollywood'],
  sports: ['sports', 'nba', 'nfl', 'mlb', 'soccer', 'olympics'],
  lifestyle: ['travel', 'tourism', 'food', 'lifestyle', 'leisure'],
};

function normalizeLabelPhrases(label: string): { phrases: string[]; tokens: string[] } {
  const normalized = label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const phrases = normalized ? [normalized] : [];
  const tokens = normalized
    ? Array.from(new Set(normalized.split(' ').filter((token) => token.length > 2)))
    : [];

  return { phrases, tokens };
}

function flattenCategories(
  categories: readonly PresetCategory[] | undefined,
  depth = 0,
  parentTokens: readonly string[] = []
): FlattenedCategory[] {
  if (!categories?.length) {
    return [];
  }

  const flattened: FlattenedCategory[] = [];

  for (const category of categories) {
    if (!category || typeof category !== 'object') {
      continue;
    }

    const label = typeof category.label === 'string' ? category.label : '';
    const id = typeof category.id === 'string' ? category.id : label.toLowerCase();

    const { phrases, tokens } = normalizeLabelPhrases(label);
    const overrideTokens = CATEGORY_KEYWORD_OVERRIDES[id]?.map((entry) =>
      entry.toLowerCase()
    );

    const allTokens = Array.from(
      new Set([
        ...parentTokens,
        ...tokens,
        ...(overrideTokens ?? []).flatMap((entry) =>
          entry.split(/[^a-z0-9]+/).filter((token) => token.length > 2)
        ),
      ])
    );

    const allPhrases = Array.from(
      new Set([
        ...phrases,
        ...(overrideTokens ?? []).map((entry) => entry.toLowerCase()),
      ])
    );

    flattened.push({ id, label, depth, phrases: allPhrases, tokens: allTokens });

    if (Array.isArray(category.children) && category.children.length > 0) {
      const childTokens = Array.from(
        new Set([
          ...allTokens,
          ...phrases.flatMap((phrase) =>
            phrase.split(/[^a-z0-9]+/).filter((token) => token.length > 2)
          ),
        ])
      );

      flattened.push(
        ...flattenCategories(category.children, depth + 1, childTokens)
      );
    }
  }

  return flattened;
}

function extractHeadlineText(headline: ReviewableHeadline): string {
  const segments = [headline.title, headline.description, headline.source]
    .map((value) => (typeof value === 'string' ? value : ''))
    .filter(Boolean);

  return segments.join(' ').toLowerCase();
}

function tokenizeHeadline(text: string): Set<string> {
  const matches = text.match(/[a-z0-9]{3,}/g);
  return new Set(matches ?? []);
}

function scoreCategory(
  headlineText: string,
  headlineTokens: Set<string>,
  category: FlattenedCategory
): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matchedTerms: string[] = [];

  for (const phrase of category.phrases) {
    if (!phrase) {
      continue;
    }

    if (headlineText.includes(phrase)) {
      matchedTerms.push(phrase);
      score += phrase.includes(' ') ? 3 : 2;
    }
  }

  for (const token of category.tokens) {
    if (headlineTokens.has(token)) {
      matchedTerms.push(token);
      score += 1;
    }
  }

  return { score, matchedTerms: Array.from(new Set(matchedTerms)) };
}

export function reviewHeadlinesAgainstCategories(
  headlines: readonly ReviewableHeadline[],
  categories: readonly PresetCategory[] | undefined
): HeadlineCategoryReviewResult[] {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return [];
  }

  const flattenedCategories = flattenCategories(categories);

  return headlines.map((headline, index) => {
    if (flattenedCategories.length === 0) {
      return {
        index,
        status: 'unmatched',
        categoryId: null,
        categoryLabel: null,
        matchedTerms: [],
        score: 0,
      } satisfies HeadlineCategoryReviewResult;
    }

    const headlineText = extractHeadlineText(headline);
    const headlineTokens = tokenizeHeadline(headlineText);

    let bestCategory: FlattenedCategory | null = null;
    let bestScore = 0;
    let bestMatchedTerms: string[] = [];

    for (const category of flattenedCategories) {
      const { score, matchedTerms } = scoreCategory(
        headlineText,
        headlineTokens,
        category
      );

      if (score === 0) {
        continue;
      }

      if (
        score > bestScore ||
        (score === bestScore && bestCategory && category.depth > bestCategory.depth)
      ) {
        bestScore = score;
        bestCategory = category;
        bestMatchedTerms = matchedTerms;
      }
    }

    if (!bestCategory) {
      return {
        index,
        status: 'unmatched',
        categoryId: null,
        categoryLabel: null,
        matchedTerms: [],
        score: 0,
      } satisfies HeadlineCategoryReviewResult;
    }

    return {
      index,
      status: 'matched',
      categoryId: bestCategory.id,
      categoryLabel: bestCategory.label,
      matchedTerms: bestMatchedTerms,
      score: bestScore,
    } satisfies HeadlineCategoryReviewResult;
  });
}
