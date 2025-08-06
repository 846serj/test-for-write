import { openai } from './openai';

export interface RecipeEmbedding {
  id: string;
  title: string;
  url?: string;
  vector: number[];
}

let cache: RecipeEmbedding[] | null = null;

export async function loadRecipeEmbeddings(): Promise<RecipeEmbedding[]> {
  if (cache) {
    return cache;
  }

  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;

  if (!apiKey || !baseId || !tableName) {
    throw new Error('Missing Airtable environment variables');
  }

  const records: any[] = [];
  let offset: string | undefined;
  const baseUrl = `https://api.airtable.com/v0/${baseId}/${tableName}`;

  do {
    const url = new URL(baseUrl);
    if (offset) {
      url.searchParams.set('offset', offset);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Airtable request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  const inputs = records.map((r) => {
    const f = r.fields || {};
    const title = f.Title || '';
    const description = f.Description || '';
    const category = f.Category || '';
    const tags = Array.isArray(f.Tags) ? f.Tags : [];
    return `${title}. ${description}. Category: ${category}. Tags: ${tags.join(', ')}`;
  });

  if (inputs.length === 0) {
    cache = [];
    return cache;
  }

  const embeddingRes = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: inputs,
  });

  cache = records.map((rec, idx) => {
    const f = rec.fields || {};
    return {
      id: rec.id,
      title: f.Title || '',
      url: f.Url || f.URL,
      vector: embeddingRes.data[idx].embedding,
    } as RecipeEmbedding;
  });

  return cache;
}

export function getCachedRecipeEmbeddings(): RecipeEmbedding[] | null {
  return cache;
}

void loadRecipeEmbeddings();
