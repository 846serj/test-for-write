import { getPrefetchedContent, setPrefetchedContent } from './prefetchCache';

const TAG_REGEX = /<\/?[^>]+(>|$)/g;

function stripMarkup(value: string): string {
  return value.replace(TAG_REGEX, ' ').replace(/\s+/g, ' ').trim();
}

export async function fetchTranscript(videoLink: string): Promise<string> {
  const url = videoLink?.trim();
  if (!url) {
    return '';
  }

  const cached = getPrefetchedContent('transcript', url);
  if (cached) {
    return cached;
  }

  try {
    const urlObj = new URL(url);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) {
      return '';
    }
    const resp = await fetch(
      `https://video.google.com/timedtext?lang=en&v=${videoId}`
    );
    const xml = await resp.text();
    const cleaned = stripMarkup(xml);
    if (cleaned) {
      setPrefetchedContent('transcript', url, cleaned);
    }
    return cleaned;
  } catch {
    return '';
  }
}

export async function fetchBlogContent(blogLink: string): Promise<string> {
  const url = blogLink?.trim();
  if (!url) {
    return '';
  }

  const cached = getPrefetchedContent('blog', url);
  if (cached) {
    return cached;
  }

  try {
    const resp = await fetch(url);
    const html = await resp.text();
    const cleaned = stripMarkup(html);
    if (cleaned) {
      setPrefetchedContent('blog', url, cleaned);
    }
    return cleaned;
  } catch {
    return '';
  }
}
