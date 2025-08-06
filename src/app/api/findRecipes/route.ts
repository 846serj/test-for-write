import { NextRequest, NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import { getCachedRecipeEmbeddings, RecipeEmbedding } from '../../../lib/recipeEmbeddings';

interface RecipeResult {
  id: string;
  title: string;
  url?: string;
  score: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export async function POST(req: NextRequest) {
  try {
    const { headline } = await req.json();
    if (!headline || typeof headline !== 'string') {
      return NextResponse.json({ error: 'headline is required' }, { status: 400 });
    }

    const [embeddingRes, recipes] = await Promise.all([
      openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: headline,
      }),
      getCachedRecipeEmbeddings(),
    ]);

    const queryEmbedding = embeddingRes.data[0].embedding as number[];

    const scored: RecipeResult[] = recipes.map((r: RecipeEmbedding) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      score: cosineSimilarity(queryEmbedding, r.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    const topTen = scored.slice(0, 10);

    return NextResponse.json(topTen);
  } catch (err) {
    console.error('findRecipes error', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
