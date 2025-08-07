import { NextRequest, NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';

interface RecipeResult {
  id: string;
  title: string;
  url?: string;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractKeywordsWithRetry(
  prompt: string,
  retries = 3,
  baseDelay = 500
): Promise<string[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const keywordRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
      });
      const keywords =
        keywordRes.choices[0]?.message?.content
          ?.split(',')
          .map((kw) => kw.trim().toLowerCase())
          .filter(Boolean) ?? [];
      if (keywords.length) return keywords;
      throw new Error('No keywords extracted');
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(baseDelay * 2 ** attempt);
    }
  }
  return [];
}

export async function POST(req: NextRequest) {
  try {
    const { headline, count } = await req.json();
    if (!headline || typeof headline !== 'string') {
      return NextResponse.json({ error: 'headline is required' }, { status: 400 });
    }

    if (
      !process.env.AIRTABLE_API_KEY ||
      !process.env.AIRTABLE_BASE_ID ||
      !process.env.AIRTABLE_TABLE_NAME
    ) {
      return NextResponse.json(
        { error: 'Airtable environment variables not configured' },
        { status: 500 }
      );
    }

    const baseUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(
      process.env.AIRTABLE_TABLE_NAME as string
    )}`;
    const headers = { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` };

    let filterFormula = "NOT({Title} = '')";
    const keywordPrompt = `Extract 3-5 key categories, tags, flavors, or dish types from this recipe roundup title: '${headline}'. Focus on the main theme, such as flavors (e.g., chocolate, vanilla) and types (e.g., desserts, cakes). Output as a comma-separated list.`;
    try {
      const keywords = await extractKeywordsWithRetry(keywordPrompt);
      if (keywords && keywords.length) {
        const parts: string[] = [];
        for (const kw of keywords) {
          parts.push(`FIND('${kw}', LOWER({Category})) > 0`);
          parts.push(`FIND('${kw}', LOWER({Tag})) > 0`);
          parts.push(`FIND('${kw}', LOWER({Title})) > 0`);
          parts.push(`FIND('${kw}', LOWER({Description})) > 0`);
        }
        filterFormula = `OR(${parts.join(',')})`;
      }
    } catch (err) {
      console.warn(
        'Keyword extraction failed after multiple attempts. Falling back to broad filter. Verify OpenAI API key or network connectivity.',
        err
      );
      filterFormula = "NOT({Title} = '')";
    }

    const maxRecords = count && count > 0 ? count : 10;
    const url = new URL(baseUrl);
    url.searchParams.append('filterByFormula', filterFormula);
    url.searchParams.append('sort[0][field]', 'Date Published');
    url.searchParams.append('sort[0][direction]', 'desc');
    url.searchParams.append('maxRecords', String(maxRecords));
    url.searchParams.append('fields[]', 'Title');
    url.searchParams.append('fields[]', 'URL');

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      console.error('Airtable fetch failed', await res.text());
      return NextResponse.json({ error: 'Failed to fetch recipes' }, { status: res.status });
    }
    const data = await res.json();
    const records = (data.records || []) as any[];

    const results: RecipeResult[] = records.map((r: any) => ({
      id: r.id,
      title: r.fields?.Title || '',
      url: r.fields?.URL,
    }));

    return NextResponse.json(results);
  } catch (err) {
    console.error('findRecipes error', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

