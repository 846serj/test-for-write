const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchAllRecords() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = 'Recipes';

  const headers = { Authorization: `Bearer ${apiKey}` };
  const baseUrl = `https://api.airtable.com/v0/${baseId}/${tableName}`;

  const records = [];
  let offset;
  do {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Airtable request failed: ${res.status}`);
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function main() {
  const records = await fetchAllRecords();

  const embeddings = [];
  for (const rec of records) {
    const f = rec.fields || {};
    const title = f.Title || '';
    const desc = f.Description || '';
    const cat = f.Category || '';
    const tags = Array.isArray(f.Tags) ? f.Tags : [];
    const text = `${title}. ${desc}. Category: ${cat}. Tags: ${tags.join(', ')}`;

    const { data: [{ embedding }] } = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    });

    embeddings.push({
      id: rec.id,
      title,
      url: f.URL || f.Url || null,
      embedding
    });
  }

  const outDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'recipeEmbeddings.json'),
    JSON.stringify(embeddings)
  );
  console.log('Generated', embeddings.length, 'embeddings.');
}

main().catch(console.error);
