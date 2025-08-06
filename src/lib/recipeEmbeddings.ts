import recipeEmbeddingsData from '../../data/recipeEmbeddings.json';

export interface RecipeEmbedding {
  id: string;
  title: string;
  url?: string;
  embedding: number[];
}

let cache: RecipeEmbedding[] | null = null;

export async function getCachedRecipeEmbeddings(): Promise<RecipeEmbedding[]> {
  if (!cache) {
    cache = recipeEmbeddingsData as RecipeEmbedding[];
  }
  return cache;
}
