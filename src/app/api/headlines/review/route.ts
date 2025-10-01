import { NextRequest, NextResponse } from 'next/server';
import type { PresetCategory } from '../../../../constants/headlineSites';
import {
  reviewHeadlinesAgainstCategories,
  type HeadlineCategoryReviewResult,
  type ReviewableHeadline,
} from '../../../../lib/headlineCategoryReview';

type ReviewRequestPayload = {
  categories?: PresetCategory[];
  headlines?: ReviewableHeadline[];
};

type ReviewResponsePayload = {
  results: HeadlineCategoryReviewResult[];
  unmatchedCount: number;
};

function normalizeHeadlines(
  headlines: unknown
): ReviewableHeadline[] | null {
  if (!Array.isArray(headlines)) {
    return null;
  }

  return headlines.map((entry) => {
    const value = typeof entry === 'object' && entry !== null ? entry : {};
    return {
      title: typeof (value as any).title === 'string' ? (value as any).title : undefined,
      description:
        typeof (value as any).description === 'string'
          ? (value as any).description
          : undefined,
      source:
        typeof (value as any).source === 'string' ? (value as any).source : undefined,
    } satisfies ReviewableHeadline;
  });
}

function normalizeCategories(categories: unknown): PresetCategory[] | null {
  if (!Array.isArray(categories)) {
    return null;
  }

  const normalized: PresetCategory[] = [];

  for (const entry of categories) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const idValue = typeof (entry as any).id === 'string' ? (entry as any).id : undefined;
    const labelValue =
      typeof (entry as any).label === 'string' ? (entry as any).label : undefined;
    const childrenValue = Array.isArray((entry as any).children)
      ? normalizeCategories((entry as any).children)
      : undefined;

    if (!labelValue) {
      continue;
    }

    const category: PresetCategory = {
      id: idValue ?? labelValue.toLowerCase(),
      label: labelValue,
    };

    if (childrenValue && childrenValue.length > 0) {
      category.children = childrenValue;
    }

    normalized.push(category);
  }

  return normalized;
}

export async function POST(request: NextRequest) {
  let payload: ReviewRequestPayload;

  try {
    payload = (await request.json()) as ReviewRequestPayload;
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const normalizedHeadlines = normalizeHeadlines(payload.headlines);
  if (!normalizedHeadlines) {
    return NextResponse.json(
      { error: 'headlines must be an array' },
      { status: 400 }
    );
  }

  const normalizedCategories = normalizeCategories(payload.categories);
  if (!normalizedCategories) {
    return NextResponse.json(
      { error: 'categories must be an array' },
      { status: 400 }
    );
  }

  const results = reviewHeadlinesAgainstCategories(
    normalizedHeadlines,
    normalizedCategories
  );

  const unmatchedCount = results.reduce(
    (total, result) => (result.status === 'unmatched' ? total + 1 : total),
    0
  );

  const responsePayload: ReviewResponsePayload = {
    results,
    unmatchedCount,
  };

  return NextResponse.json(responsePayload);
}
