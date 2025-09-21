export const CATEGORY_FEED_CONFIG = [
  { value: 'business', label: 'Business' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'general', label: 'General' },
  { value: 'health', label: 'Health' },
  { value: 'science', label: 'Science' },
  { value: 'sports', label: 'Sports' },
  { value: 'technology', label: 'Technology' },
] as const;

export type CategoryFeedConfig = (typeof CATEGORY_FEED_CONFIG)[number];
export type CategoryFeedValue = CategoryFeedConfig['value'];

export const CATEGORY_FEED_VALUES: readonly CategoryFeedValue[] = CATEGORY_FEED_CONFIG.map(
  (feed) => feed.value
);

export const CATEGORY_FEED_SET: ReadonlySet<CategoryFeedValue> = new Set(
  CATEGORY_FEED_VALUES
);

export const CATEGORY_FEED_OPTIONS = CATEGORY_FEED_CONFIG;

export function isCategoryFeedValue(
  value: string
): value is CategoryFeedValue {
  return CATEGORY_FEED_SET.has(value as CategoryFeedValue);
}
