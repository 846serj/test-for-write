// SERPAPI Response Types
export interface SerpApiResult {
  link: string;
  title?: string;
  snippet?: string;
}

export interface SerpApiResponse {
  organic_results?: SerpApiResult[];
  news_results?: SerpApiResult[];
  error?: string;
}

// WordPress Response Types
export interface WordPressPostResponse {
  link: string;
  id: number;
  status: string;
  title: {
    rendered: string;
  };
  content: {
    rendered: string;
  };
}

export interface RecipeResult {
  id: string;
  title: string;
  url?: string;
}
