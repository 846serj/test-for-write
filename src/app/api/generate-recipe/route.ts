import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';
import { getCenterCropRegion, getCroppedImg } from '../../../utils/imageCrop';

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

    // Use embeddings to rank recipes by relevance to the provided title
    if (title && records.length > 0) {
      try {
        const recordTexts = records.map((r) => {
          const f = r.fields || {};
          const name =
            f.Name ||
            f.Title ||
            f.title ||
            f.recipe ||
            '';
          const cats =
            f.Categories ||
            f.Category ||
            f.categories ||
            f.category ||
            f.Tags ||
            '';
          const catsStr = Array.isArray(cats) ? cats.join(' ') : cats;
          return `${name} ${catsStr}`.trim();
        });

        const embeddingRes = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: [title, ...recordTexts],
        });

        const [titleEmbedding, ...recipeEmbeddings] = embeddingRes.data.map(
          (d: any) => d.embedding
        );

        const cosineSim = (a: number[], b: number[]) => {
          let dot = 0,
            normA = 0,
            normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        };

        records = records
          .map((rec, idx) => ({ rec, sim: cosineSim(titleEmbedding, recipeEmbeddings[idx]) }))
          .sort((a, b) => b.sim - a.sim)
          .map((r) => r.rec);
      } catch (err) {
        console.error('Embedding ranking failed', err);
      }
    }

    // If a specific number of items is requested, slice the records after ranking
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

      let finalImageUrl = imageUrl;
      if (imageUrl) {
        try {
          const imgRes = await fetch(imageUrl);
          if (imgRes.ok) {
            const arrayBuffer = await imgRes.arrayBuffer();
            const imgBuffer = Buffer.from(arrayBuffer);
            const metadata = await sharp(imgBuffer).metadata();
            if (metadata.width && metadata.height) {
              const cropRegion = getCenterCropRegion(metadata.width, metadata.height);
              const croppedBuffer = await getCroppedImg(imgBuffer, cropRegion, 1280, 720);
              finalImageUrl = `data:image/jpeg;base64,${croppedBuffer.toString('base64')}`;
            }
          }
        } catch (e) {
          console.error('Image processing failed', e);
        }
      }

      // Always generate a 3-4 sentence description with OpenAI, using any
      // existing description as context when available
      const contextDesc =
        typeof fields.Description === 'string'
          ? fields.Description.slice(0, 200)
          : '';
      const nextFields = records[i + 1]?.fields;
      const nextName =
        nextFields &&
        (nextFields.Name ||
          nextFields.Title ||
          nextFields.title ||
          nextFields.recipe);
      let descPrompt = `Write a 3-4 sentence engaging description for the recipe "${recipeName}".`;
      if (contextDesc) {
        descPrompt += ` Use this context if helpful: ${contextDesc}`;
      }
      if (nextName) {
        descPrompt += ` Conclude with a short transitional sentence introducing the next recipe, "${nextName}".`;
      }
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
      if (finalImageUrl) {
        content +=
          `<!-- wp:image {"sizeSlug":"large","linkDestination":"custom"} -->\n` +
          `<figure class="wp-block-image size-large"><a href="${recipeUrl}" target="_blank" rel="noreferrer noopener"><img src="${finalImageUrl}" alt="${recipeName}"/></a>` +
          `${source ? `<figcaption class="wp-element-caption">Image by ${source}</figcaption>` : ''}</figure>\n` +
          `<!-- /wp:image -->\n`;
      }
      content +=
        `<!-- wp:paragraph -->\n<p>${description} ${recipeUrl ? `<a href="${recipeUrl}" target="_blank" rel="noreferrer noopener">${recipeName}</a>` : ''}</p>\n<!-- /wp:paragraph -->\n\n`;
    }

    // Add a concluding paragraph to tie the recipes together
    if (records.length > 0 && title) {
      try {
        const recipeNames = records
          .map((r) => {
            const f = r.fields || {};
            return (
              f.Name ||
              f.Title ||
              f.title ||
              f.recipe ||
              ''
            );
          })
          .filter(Boolean)
          .join(', ');
        const outroPrompt = `Write a brief concluding paragraph for an article titled "${title}" that featured these recipes: ${recipeNames}. Connect them smoothly and end on an inviting note.`;
        const outroRes = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'You are an expert blog writer.' },
            { role: 'user', content: outroPrompt }
          ]
        });
        const outroText = outroRes.choices[0]?.message?.content?.trim() || '';
        if (outroText) {
          content += `<!-- wp:paragraph -->\n<p>${outroText}</p>\n<!-- /wp:paragraph -->\n`;
        }
      } catch (e) {
        console.error('Conclusion generation failed', e);
      }
    }

    return NextResponse.json({ content }, { status: 200 });
  } catch (err) {
    console.error('Error in generate-recipe route:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
