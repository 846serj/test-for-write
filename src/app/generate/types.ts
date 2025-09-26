export type RelatedArticle = {
  title?: string;
  description?: string;
  url?: string;
  source?: string;
  publishedAt?: string;
};

export type HeadlineItem = {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  description?: string;
  matchedQuery?: string;
  relatedArticles?: RelatedArticle[];
};
