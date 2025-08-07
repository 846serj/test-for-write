import { NextRequest, NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import type { RecipeResult } from '../../../types/api';

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
    try {
      const keywordPrompt = `Extract 3-5 key categories, tags, flavors, or dish types from this recipe roundup title: '${headline}'. Focus on the main theme, such as flavors (e.g., chocolate, vanilla) and types (e.g., desserts, cakes). Output as a comma-separated list.`;
      const keywordRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: keywordPrompt }],
        max_tokens: 50,
      });
      const keywords = keywordRes.choices[0]?.message?.content
        ?.split(',')
        .map((kw) => kw.trim().toLowerCase())
        .filter(Boolean);
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
      console.error('Keyword extraction failed', err);
    }

    const maxRecords = count && count > 0 ? count : 10;
    const url = new URL(baseUrl);
    url.searchParams.append('filterByFormula', filterFormula);
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

