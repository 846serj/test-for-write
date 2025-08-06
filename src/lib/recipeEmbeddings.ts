export interface RecipeEmbedding {
  id: string;
  title: string;
  url?: string;
  embedding: number[];
}

let cache: RecipeEmbedding[] | null = null;

export async function getCachedRecipeEmbeddings(): Promise<RecipeEmbedding[]> {
  if (cache) return cache;
  const url = process.env.RECIPE_EMBEDDINGS_URL;
  if (!url) {
    cache = [];
    return cache;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      cache = [];
      return cache;
    }
    cache = (await res.json()) as RecipeEmbedding[];
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}
