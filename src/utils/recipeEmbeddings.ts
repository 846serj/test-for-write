export interface RecipeEmbedding {
  id: string;
  embedding: number[];
}

let cache: RecipeEmbedding[] | null = null;

export async function getCachedRecipeEmbeddings(): Promise<RecipeEmbedding[]> {
  if (cache) {
    return cache;
  }
  const url = process.env.RECIPE_EMBEDDINGS_URL;
  if (!url) {
    console.warn('RECIPE_EMBEDDINGS_URL not configured');
    cache = [];
    return cache;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch recipe embeddings: ${res.status}`);
    }
    const data = await res.json();
    cache = data as RecipeEmbedding[];
    return cache;
  } catch (err) {
    console.error('Error fetching recipe embeddings', err);
    cache = [];
    return cache;
  }
}
