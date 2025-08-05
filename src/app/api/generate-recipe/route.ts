import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

export async function POST(request: NextRequest) {
  try {
    // Parse request JSON for necessary fields
    const body = await request.json();
    const title: string = body.title || '';
    const wordsPerItem: number = body.wordsPerItem ? parseInt(body.wordsPerItem) : 100;
    const numberingFormat: string = body.numberingFormat || '1.';  // e.g. "1." or "1)" or "none"
    const itemCount: number | undefined = body.itemCount ? parseInt(body.itemCount) : undefined;

    // Ensure Airtable environment variables are set
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID || !process.env.AIRTABLE_TABLE_NAME) {
      return NextResponse.json({ error: 'Airtable environment variables not configured' }, { status: 500 });
    }

    // Fetch recipe records from Airtable
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`;
    const airtableRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}` }
    });
    if (!airtableRes.ok) {
      const errorText = await airtableRes.text();
      return NextResponse.json({ error: `Airtable request failed: ${errorText}` }, { status: 500 });
    }
    const airtableData = await airtableRes.json();
    let records: any[] = airtableData.records || [];

    // If a specific number of items is requested, slice the records
    if (itemCount && itemCount > 0) {
      records = records.slice(0, itemCount);
    }

    let content = '';
    // Optionally generate an introduction using OpenAI, based on the given title
    if (title) {
      const introPrompt = `Write a short introductory paragraph for a blog post titled "${title}".`;
      const introResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an expert blog writer.' },
          { role: 'user', content: introPrompt }
        ]
      });
      const introText = introResponse.choices[0]?.message?.content?.trim() || '';
      if (introText) {
        content += `<!-- wp:paragraph -->\n<p>${introText}</p>\n<!-- /wp:paragraph -->\n\n`;
      }
    }

    // Generate a list section for each recipe record
    for (let i = 0; i < records.length; i++) {
      const fields = records[i].fields;
      const recipeName: string =
        fields.Name ||
        fields.Title ||
        fields.title ||
        fields.recipe ||
        `Recipe ${i + 1}`;

      const recipeUrl: string =
        fields.URL ||
        fields.Url ||
        fields.link ||
        fields.Link ||
        '';

      const imageUrl: string =
        fields['Image Link'] ||
        (Array.isArray(fields.Image) && fields.Image[0]?.url) ||
        fields.image ||
        '';

      const source: string = fields.Source || fields['Blog Source'] || '';

      // Always generate a 3-4 sentence description with OpenAI, using any
      // existing description as context when available
      const contextDesc =
        typeof fields.Description === 'string'
          ? fields.Description.slice(0, 200)
          : '';
      const descPrompt = `Write a 3-4 sentence engaging description for the recipe "${recipeName}". Use this context if helpful: ${contextDesc}`;
      const descResponse = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful culinary assistant.' },
          { role: 'user', content: descPrompt }
        ],
        max_tokens: Math.max(100, wordsPerItem)
      });
      const description = descResponse.choices[0]?.message?.content?.trim() || '';

      // Determine numbering prefix based on format (e.g., "1. ", "1) ", or none)
      let prefix = '';
      if (numberingFormat.toLowerCase() !== 'none') {
        // Use ")" if format contains it, otherwise use "." by default
        prefix = numberingFormat.includes(')') ? `${i + 1}) ` : `${i + 1}. `;
      }

      // Append the heading, image (if any), and paragraph blocks for this recipe item
      content += `<!-- wp:heading {"level":2} -->\n<h2>${prefix}${recipeName}</h2>\n<!-- /wp:heading -->\n`;
      if (imageUrl) {
        content +=
          `<!-- wp:image {"sizeSlug":"large","linkDestination":"custom"} -->\n` +
          `<figure class="wp-block-image size-large"><a href="${recipeUrl}" target="_blank" rel="noreferrer noopener"><img src="${imageUrl}" alt="${recipeName}"/></a>` +
          `${source ? `<figcaption class="wp-element-caption">Image by ${source}</figcaption>` : ''}</figure>\n` +
          `<!-- /wp:image -->\n`;
      }
      content +=
        `<!-- wp:paragraph -->\n<p>${description} ${recipeUrl ? `<a href="${recipeUrl}" target="_blank" rel="noreferrer noopener">${recipeName}</a>` : ''}</p>\n<!-- /wp:paragraph -->\n\n`;
    }

    // (Optional: add a conclusion or closing paragraph if needed using OpenAI)

    return NextResponse.json({ content }, { status: 200 });
  } catch (err) {
    console.error('Error in generate-recipe route:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
