import { NextRequest, NextResponse } from 'next/server';

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 5;

function resolveLimit(rawLimit: unknown): number {
  let numeric: number | null = null;

  if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
    numeric = rawLimit;
  } else if (typeof rawLimit === 'string' && rawLimit.trim()) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed)) {
      numeric = parsed;
    }
  }

  if (numeric === null) {
    return DEFAULT_LIMIT;
  }

  const truncated = Math.trunc(numeric);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, truncated));
}

export async function POST(req: NextRequest) {
  let body: { query?: unknown; limit?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return NextResponse.json(
      { error: 'query is required' },
      { status: 400 }
    );
  }

  const limit = resolveLimit(body.limit);
  const apiKey = process.env.NEWSAPI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'NEWSAPI_API_KEY is not configured' },
      { status: 500 }
    );
  }

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', query);
  url.searchParams.set('pageSize', String(limit));
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
      },
    });
  } catch (error) {
    console.error('[api/headlines] request failed', error);
    return NextResponse.json(
      { error: 'Failed to reach NewsAPI' },
      { status: 502 }
    );
  }

  let data: any = null;
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = text ? { message: text } : null;
    }
  } catch (error) {
    console.error('[api/headlines] failed to parse response', error);
    if (!response.ok) {
      return NextResponse.json(
        { error: 'NewsAPI request failed' },
        { status: response.status || 502 }
      );
    }
    return NextResponse.json(
      { error: 'Invalid response from NewsAPI' },
      { status: 502 }
    );
  }

  if (!response.ok) {
    const message =
      (data && typeof data.message === 'string' && data.message) ||
      'NewsAPI request failed';
    return NextResponse.json(
      { error: message },
      { status: response.status || 502 }
    );
  }

  if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
    return NextResponse.json(
      { error: 'Unexpected response from NewsAPI' },
      { status: 502 }
    );
  }

  const headlines = data.articles
    .map((article: any) => ({
      title: article?.title ?? '',
      description: article?.description ?? article?.content ?? '',
      url: article?.url ?? '',
      source: article?.source?.name ?? '',
      publishedAt: article?.publishedAt ?? article?.published_at ?? '',
    }))
    .filter((article: any) => article.title && article.url)
    .slice(0, limit);

  return NextResponse.json({ headlines });
}
