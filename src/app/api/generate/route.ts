// route.ts
import { NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import { DEFAULT_WORDS, WORD_RANGES } from '../../../constants/lengthOptions';
import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';

export const runtime = 'edge';
export const revalidate = 0;

type NewsFreshness = '1h' | '6h' | '7d';

interface NewsArticle {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

interface ReportingSource {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

const FRESHNESS_TO_HOURS: Record<NewsFreshness, number> = {
  '1h': 1,
  '6h': 6,
  '7d': 24 * 7,
};

const sectionRanges: Record<string, [number, number]> = {
  shorter: [2, 4],
  short: [3, 5],
  medium: [4, 6],
  longForm: [5, 7],
  longer: [6, 8],
};

function linksClusteredNearEnd(content: string): boolean {
  if (!content) {
    return false;
  }

  const anchorRegex = /<a\s+href\b[^>]*>/gi;
  const linkPositions: number[] = [];
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRegex.exec(content)) !== null) {
    linkPositions.push(anchorMatch.index);
  }

  if (linkPositions.length === 0) {
    return false;
  }

  const blockRegex = /<(p|h2)\b[^>]*>/gi;
  const blockStarts: number[] = [];
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(content)) !== null) {
    blockStarts.push(blockMatch.index);
  }

  if (blockStarts.length >= 2) {
    const blockBoundaries = blockStarts.map((start, idx) => ({
      start,
      end: idx + 1 < blockStarts.length ? blockStarts[idx + 1] : content.length,
    }));
    const lastBlockIndex = blockBoundaries.length - 1;
    const allInLastBlock = linkPositions.every((pos) => {
      for (let i = blockBoundaries.length - 1; i >= 0; i -= 1) {
        const boundary = blockBoundaries[i];
        if (pos >= boundary.start) {
          return i === lastBlockIndex;
        }
      }
      return false;
    });

    if (allInLastBlock) {
      return true;
    }
  }

  const threshold = Math.floor(content.length * 0.75);
  if (threshold <= 0) {
    return false;
  }

  return linkPositions.every((pos) => pos >= threshold);
}

function normalizeTitleValue(title: string | undefined | null): string {
  const holder = normalizeTitleValue as unknown as {
    _publisherData?: {
      knownWords: Set<string>;
      knownExact: Set<string>;
    };
  };

  if (!holder._publisherData) {
    holder._publisherData = {
      knownWords: new Set([
        'news',
        'times',
        'post',
        'journal',
        'tribune',
        'guardian',
        'gazette',
        'review',
        'report',
        'chronicle',
        'daily',
        'herald',
        'press',
        'today',
        'insider',
        'bloomberg',
        'reuters',
        'axios',
        'politico',
        'verge',
        'engadget',
        'techcrunch',
        'wired',
        'cnbc',
        'cnn',
        'bbc',
        'cbs',
        'abc',
        'fox',
        'fortune',
        'forbes',
        'npr',
        'yahoo',
        'ap',
        'barron',
        "barron's",
        'wsj',
        'telegraph',
        'independent',
        'register',
        'observer',
        'courier',
        'star',
        'globe',
        'sun',
        'mirror',
        'economist',
        'financial',
      ]),
      knownExact: new Set([
        'new york times',
        'washington post',
        'wall street journal',
        'associated press',
        'financial times',
        'usa today',
        'los angeles times',
        'la times',
        'business insider',
        'the verge',
        'the guardian',
        'the atlantic',
        'the economist',
        'sky news',
        'cnet',
        'buzzfeed news',
      ]),
    };
  }

  const { knownWords, knownExact } = holder._publisherData;

  function isLikelyPublisherSegment(segment: string): boolean {
    const trimmed = segment.trim();
    if (!trimmed) return false;

    const stripped = trimmed.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
    if (!stripped) return false;

    const lowered = stripped.toLowerCase();
    if (knownExact.has(lowered)) {
      return true;
    }

    if (lowered.includes('.com') || lowered.includes('.net') || lowered.includes('.org')) {
      return true;
    }

    const loweredWords = lowered.split(/\s+/);
    if (loweredWords.length === 0 || loweredWords.length > 6) {
      return false;
    }

    if (loweredWords.some((word) => knownWords.has(word))) {
      return true;
    }

    const originalWords = trimmed.split(/\s+/);
    let alphaWordCount = 0;
    let titleCasedCount = 0;

    for (const word of originalWords) {
      if (!/[A-Za-z]/.test(word)) {
        continue;
      }
      alphaWordCount += 1;

      if (word === word.toUpperCase()) {
        titleCasedCount += 1;
        continue;
      }

      const first = word.charAt(0);
      const rest = word.slice(1);
      if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
        titleCasedCount += 1;
      }
    }

    if (alphaWordCount > 0 && titleCasedCount >= alphaWordCount - 1) {
      return true;
    }

    return false;
  }

  let normalized = (title ?? '').trim();
  const trailingSeparatorRegex = /\s*[\-–—|]\s*([^\-–—|]+)$/;

  while (true) {
    const match = normalized.match(trailingSeparatorRegex);
    if (!match) {
      break;
    }

    const segment = match[1]?.trim() ?? '';
    if (!segment) {
      break;
    }

    if (!isLikelyPublisherSegment(segment)) {
      break;
    }

    normalized = normalized.slice(0, normalized.length - match[0].length).trimEnd();
  }

  normalized = normalized.replace(/[\s]*[\-–—|:;,]+$/g, '').trim();

  return normalized.toLowerCase().replace(/\s+/g, ' ');
}

function getWordBounds(
  lengthOption: string | undefined,
  customSections: number | undefined
): [number, number] {
  if (lengthOption === 'custom' && customSections) {
    const approx = customSections * 220;
    return [Math.floor(approx * 0.8), Math.ceil(approx * 1.2)];
  }
  if (lengthOption && WORD_RANGES[lengthOption]) {
    return WORD_RANGES[lengthOption];
  }
  return [DEFAULT_WORDS - 150, DEFAULT_WORDS + 150];
}


// Minimum number of source links to include in generated content
const MIN_LINKS = 3;

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

// Encourage more concrete examples by default
const DETAIL_INSTRUCTION =
  '- Provide specific real-world examples (e.g., car model years or actual app names) instead of generic placeholders like "App 1".\n';

function calcMaxTokens(
  lengthOption: string | undefined,
  customSections: number | undefined,
  model: string
): number {
  let desiredWords: number;
  if (lengthOption === 'custom' && customSections) {
    desiredWords = customSections * 220;
  } else if (lengthOption && WORD_RANGES[lengthOption]) {
    const [minW, maxW] = WORD_RANGES[lengthOption];
    desiredWords = (minW + maxW) / 2;
  } else {
    desiredWords = DEFAULT_WORDS;
  }
  const tokens = Math.ceil(desiredWords / 0.75);
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  return Math.min(tokens, limit);
}

async function fetchSources(
  headline: string,
  freshness?: NewsFreshness
): Promise<ReportingSource[]> {
  const resolvedFreshness = resolveFreshness(freshness);
  const results = await serpapiSearch({
    query: headline,
    engine: 'google_news',
    extraParams: { tbs: mapFreshnessToSerpTbs(resolvedFreshness) },
    limit: 8,
  });

  const seenLinks = new Set<string>();
  const seenPublishers = new Set<string>();
  const seenTitles = new Set<string>();
  const orderedSources: ReportingSource[] = [];

  for (const result of results) {
    const normalizedTitle = normalizeTitleValue(result.title);
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      continue;
    }

    const link = result.link;
    if (!link || seenLinks.has(link)) {
      continue;
    }

    const publisherId = normalizePublisher(result);
    if (!publisherId || seenPublishers.has(publisherId)) {
      continue;
    }

    const summary = (result.snippet || result.summary || '').replace(/\s+/g, ' ').trim();
    const publishedAt =
      result.date || result.published_at || result.date_published || '';
    const title = result.title || 'Untitled';

    seenLinks.add(link);
    seenPublishers.add(publisherId);
    if (normalizedTitle) {
      seenTitles.add(normalizedTitle);
    }

    orderedSources.push({
      title,
      url: link,
      summary,
      publishedAt,
    });

    if (orderedSources.length >= 5) {
      break;
    }
  }

  return orderedSources;
}

function formatPublishedTimestamp(value: string): string {
  if (!value) {
    return 'Unknown publication time';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown publication time';
  }
  return date.toISOString();
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.replace(/\s+/g, ' ').trim();
  return trimmed || 'No summary provided.';
}

function buildRecentReportingBlock(sources: ReportingSource[]): string {
  if (!sources.length) {
    return '';
  }

  const entries = sources
    .map((item) => {
      const timestamp = formatPublishedTimestamp(item.publishedAt);
      const summary = normalizeSummary(item.summary);
      const title = item.title || 'Untitled';
      return `- "${title}" (${timestamp})\n  Summary: ${summary}\n  URL: ${item.url}`;
    })
    .join('\n');

  return `Recent reporting to reference:\n${entries}`;
}

function normalizePublisher(result: SerpApiResult): string | null {
  const rawSource = typeof result.source === 'string' ? result.source : '';
  const normalizedSource = rawSource.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedSource) {
    return normalizedSource;
  }

  const link = result.link;
  if (!link) return null;

  try {
    const hostname = new URL(link).hostname.toLowerCase();
    if (!hostname) return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function resolveFreshness(freshness: NewsFreshness | undefined): NewsFreshness {
  if (!freshness) return '6h';
  return freshness;
}

function mapFreshnessToSerpTbs(freshness: NewsFreshness): string {
  if (freshness === '1h') return 'qdr:h';
  if (freshness === '6h') return 'qdr:h6';
  return 'qdr:w';
}

function computeFreshnessIso(freshness: NewsFreshness): string {
  const hours = FRESHNESS_TO_HOURS[freshness] ?? FRESHNESS_TO_HOURS['6h'];
  const from = new Date(Date.now() - hours * 60 * 60 * 1000);
  return from.toISOString();
}

async function fetchNewsArticles(
  query: string,
  freshness: NewsFreshness | undefined,
  serpFallbackEnabled: boolean
): Promise<NewsArticle[]> {
  const resolvedFreshness = resolveFreshness(freshness);
  const fromIso = computeFreshnessIso(resolvedFreshness);
  const newsKey = process.env.NEWS_API_KEY;

  if (newsKey) {
    try {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', query);
      url.searchParams.set('from', fromIso);
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', '8');
      const resp = await fetch(url, {
        headers: { 'X-Api-Key': newsKey },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.status === 'ok' && Array.isArray(data.articles)) {
          const parsed = (data.articles as any[])
            .map((article) => ({
              title: article?.title || article?.headline || 'Untitled',
              url: article?.url || '',
              summary:
                article?.description || article?.content || article?.summary || '',
              publishedAt:
                article?.publishedAt || article?.updatedAt || article?.date || '',
            }))
            .filter((item: NewsArticle) => item.title && item.url);
          if (parsed.length > 0) {
            return parsed.slice(0, 8);
          }
        }
      }
    } catch (err) {
      console.warn('[api/generate] news api fetch failed, falling back to SerpAPI', err);
    }
  }

  if (!serpFallbackEnabled || !process.env.SERPAPI_KEY) {
    return [];
  }

  const freshnessParam = mapFreshnessToSerpTbs(resolvedFreshness);

  try {
    const serpResults = await serpapiSearch({
      query,
      engine: 'google_news',
      extraParams: { tbs: freshnessParam },
      limit: 8,
    });

    const seenTitles = new Set<string>();
    const articles: NewsArticle[] = [];

    for (const item of serpResults) {
      const normalizedTitle = normalizeTitleValue(item.title);
      if (normalizedTitle && seenTitles.has(normalizedTitle)) {
        continue;
      }

      const article: NewsArticle = {
        title: item.title || 'Untitled',
        url: item.link || '',
        summary: item.snippet || '',
        publishedAt: item.date || item.published_at || '',
      };

      if (!article.title || !article.url) {
        continue;
      }

      if (normalizedTitle) {
        seenTitles.add(normalizedTitle);
      }

      articles.push(article);

      if (articles.length >= 8) {
        break;
      }
    }

    return articles;
  } catch (err) {
    console.warn('[api/generate] serpapi fallback failed', err);
    return [];
  }
}

// Fetch YouTube captions
async function fetchTranscript(videoLink: string): Promise<string> {
  try {
    const urlObj = new URL(videoLink);
    const videoId = urlObj.searchParams.get('v');
    if (!videoId) return '';
    const resp = await fetch(
      `https://video.google.com/timedtext?lang=en&v=${videoId}`
    );
    const xml = await resp.text();
    return xml.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Fetch and strip a blog post's HTML
async function fetchBlogContent(blogLink: string): Promise<string> {
  try {
    const resp = await fetch(blogLink);
    const html = await resp.text();
    return html.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Fetch and optionally summarize blog content
async function summarizeBlogContent(
  blogLink: string,
  useSummary: boolean,
  model: string
): Promise<string> {
  const original = await fetchBlogContent(blogLink);
  if (!original) return '';
  if (!useSummary) return original;
  try {
    const prompt = `Summarize the following article in bullet points.\n\n${original}`;
    const res = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 300,
    });
    return res.choices[0]?.message?.content?.trim() || original;
  } catch {
    return original;
  }
}

function normalizeHrefValue(url: string): string {
  return url.replace(/&amp;/g, '&').trim();
}

function buildUrlVariants(url: string): string[] {
  const normalized = normalizeHrefValue(url);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);
  if (normalized.endsWith('/')) {
    variants.add(normalized.slice(0, -1));
  } else {
    variants.add(`${normalized}/`);
  }

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    const href = parsed.toString();
    variants.add(href);
    if (href.endsWith('/')) {
      variants.add(href.slice(0, -1));
    } else {
      variants.add(`${href}/`);
    }
  } catch {
    // Ignore malformed URLs that cannot be parsed.
  }

  return Array.from(variants);
}

function cleanModelOutput(raw: string | null | undefined): string {
  return (raw || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function findMissingSources(content: string, sources: string[]): string[] {
  if (!sources.length) {
    return [];
  }

  const cited = new Set<string>();
  const anchorRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(content)) !== null) {
    const href = match[1];
    for (const variant of buildUrlVariants(href)) {
      if (variant) {
        cited.add(variant);
      }
    }
  }

  const missing: string[] = [];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    let found = false;
    for (const variant of buildUrlVariants(source)) {
      if (variant && cited.has(variant)) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push(source);
    }
  }

  return missing;
}

// Generate article content and ensure a minimum number of links are present
// prompt   - text prompt to send to the model
// model    - model name to use
// sources  - list of source URLs that may be linked
// minLinks - minimum number of <a href> links required in the output
async function generateWithLinks(
  prompt: string,
  model: string,
  sources: string[],
  systemPrompt?: string,
  minLinks: number = MIN_LINKS,
  maxTokens = 2000,
  minWords = 0
): Promise<string> {
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  let tokens = Math.min(maxTokens, limit);
  const buildMessages = (content: string) =>
    systemPrompt
      ? [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content },
        ]
      : [{ role: 'user' as const, content }];

  let baseRes = await openai.chat.completions.create({
    model,
    messages: buildMessages(prompt),
    temperature: 0.7,
    max_tokens: tokens,
  });

  // If the response was cut off due to max_tokens, retry once with more room
  if (baseRes.choices[0]?.finish_reason === 'length' && tokens < limit) {
    tokens = Math.min(tokens * 2, limit);
    baseRes = await openai.chat.completions.create({
      model,
      messages: buildMessages(prompt),
      temperature: 0.7,
      max_tokens: tokens,
    });
  }

  let content = cleanModelOutput(baseRes.choices[0]?.message?.content);

  if (sources.length > 0) {
    let missingSources = findMissingSources(content, sources);
    if (missingSources.length > 0) {
      const retryPrompt = `${prompt}\n\nYou failed to cite the following required sources:\n${missingSources
        .map((url) => `- ${url}`)
        .join('\n')}\nAdd a clickable HTML link for each listed URL using <a href="URL" target="_blank">text</a> exactly once, weave it into the paragraph that references that source, retain the other citations you already provided, and do not append a standalone list of links at the end.`;
      const retryRes = await openai.chat.completions.create({
        model,
        messages: buildMessages(retryPrompt),
        temperature: 0.7,
        max_tokens: tokens,
      });
      content = cleanModelOutput(
        retryRes.choices[0]?.message?.content || content
      );
      missingSources = findMissingSources(content, sources);
      if (missingSources.length > 0) {
        throw new Error(
          `Model failed to cite required sources: ${missingSources.join(', ')}`
        );
      }
    }
  }

  let linkCount = content.match(/<a\s+href=/gi)?.length || 0;

  if (linkCount < minLinks && sources.length > 0) {
    const retryPrompt = `${prompt}\n\nYou forgot to include at least ${minLinks} links. Integrate clickable HTML links for every provided source using <a href="URL" target="_blank">text</a> inside the relevant paragraphs, and do not append a final list of links.`;
    const retryRes = await openai.chat.completions.create({
      model,
      messages: buildMessages(retryPrompt),
      temperature: 0.7,
      max_tokens: tokens,
    });
    content = cleanModelOutput(
      retryRes.choices[0]?.message?.content || content
    );
    linkCount = content.match(/<a\s+href=/gi)?.length || 0;
    if (sources.length > 0) {
      const missingSources = findMissingSources(content, sources);
      if (missingSources.length > 0) {
        throw new Error(
          `Model failed to cite required sources: ${missingSources.join(', ')}`
        );
      }
    }
  }

  if (sources.length > 0 && linksClusteredNearEnd(content)) {
    const retryPrompt = `${prompt}\n\nYour previous draft clustered the citations at the end. Rewrite the article so each listed source URL is woven into the paragraph or section that discusses it. Keep every <a href> citation inline with the relevant content and do not append a final list of links.`;
    const retryRes = await openai.chat.completions.create({
      model,
      messages: buildMessages(retryPrompt),
      temperature: 0.7,
      max_tokens: tokens,
    });
    content = cleanModelOutput(
      retryRes.choices[0]?.message?.content || content
    );
    const missingSources = findMissingSources(content, sources);
    if (missingSources.length > 0) {
      throw new Error(
        `Model failed to cite required sources: ${missingSources.join(', ')}`
      );
    }
    linkCount = content.match(/<a\s+href=/gi)?.length || 0;
    if (linkCount < minLinks) {
      throw new Error(
        `Model failed to include at least ${minLinks} links after redistributing citations.`
      );
    }
    if (linksClusteredNearEnd(content)) {
      throw new Error(
        'Model continued to cluster citations at the end after correction.'
      );
    }
  }

  if (minWords > 0) {
    const textOnly = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textOnly ? textOnly.split(/\s+/).length : 0;
    if (wordCount < minWords && tokens < limit) {
      tokens = Math.min(tokens * 2, limit);
      const expandPrompt = `${prompt}\n\nYour previous response was only ${wordCount} words. Expand it to at least ${minWords} words while keeping the same structure and links. Ensure every citation remains inline with its relevant paragraph and do not append a final list of links.`;
      const retryRes = await openai.chat.completions.create({
        model,
        messages: buildMessages(expandPrompt),
        temperature: 0.7,
        max_tokens: tokens,
      });
      content = cleanModelOutput(
        retryRes.choices[0]?.message?.content || content
      );
      if (sources.length > 0) {
        const missingSources = findMissingSources(content, sources);
        if (missingSources.length > 0) {
          throw new Error(
            `Model failed to cite required sources: ${missingSources.join(', ')}`
          );
        }
      }
    }
  }

  if (sources.length > 0) {
    const missingSources = findMissingSources(content, sources);
    if (missingSources.length > 0) {
      throw new Error(
        `Model failed to cite required sources: ${missingSources.join(', ')}`
      );
    }
  }

  return content;
}

export async function POST(request: Request) {
  try {
    const {
      articleType,
      title,
      listNumberingFormat,
      listItemWordCount = 100,
      videoLink,
      blogLink,
      toneOfVoice,
      customTone,
      pointOfView,
      customInstructions,
      lengthOption,
      customSections,
      modelVersion = 'gpt-4o-mini',
      useSerpApi = true,
      includeLinks = true,
      useSummary = false,
      newsFreshness,
    }: {
      articleType: string;
      title: string;
      listNumberingFormat?: string;
      listItemWordCount?: number;
      videoLink?: string;
      blogLink?: string;
      toneOfVoice?: string;
      customTone?: string;
      pointOfView?: string;
      customInstructions?: string;
      lengthOption?: string;
      customSections?: number;
      modelVersion?: string;
      useSerpApi?: boolean;
      includeLinks?: boolean;
      useSummary?: boolean;
      newsFreshness?: NewsFreshness;
    } = await request.json();

    if (!title?.trim()) {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 });
    }

    const serpEnabled = includeLinks && useSerpApi && !!process.env.SERPAPI_KEY;
    const baseMaxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);
    const nowIso = new Date().toISOString();
    const systemPrompt = `The current date and time is ${nowIso}. Treat the reporting summaries and source links supplied in prompts as authoritative context. Avoid introducing unsourced details or time-sensitive claims that are not confirmed by those references.`;

    const toneChoice =
      toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
    const toneInstruction = toneChoice
      ? `- Write in a ${toneChoice} tone of voice.\n`
      : '';
    const povInstruction = pointOfView
      ? `- Use a ${pointOfView} perspective.\n`
      : '';

    if (articleType === 'News article') {
      const articles = await fetchNewsArticles(title, newsFreshness, serpEnabled);
      if (!articles.length) {
        return NextResponse.json(
          { error: 'No recent news articles found for that topic.' },
          { status: 502 }
        );
      }

      const newsSources = Array.from(
        new Set(articles.map((item) => item.url).filter(Boolean))
      );
      const linkSources = includeLinks ? newsSources : [];
      const minLinks = includeLinks
        ? Math.min(MIN_LINKS, linkSources.length)
        : 0;
      const linkInstruction =
        includeLinks && linkSources.length
          ? `- Integrate clickable HTML links for every one of the following sources into relevant keywords or phrases.\n${linkSources
              .map((u) => `  - ${u}`)
              .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
          : '';

      const reportingBlock = buildRecentReportingBlock(articles);

      let lengthInstruction = '';
      if (lengthOption === 'custom' && customSections) {
        const approx = customSections * 220;
        lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
      } else if (lengthOption && WORD_RANGES[lengthOption]) {
        const [minW, maxW] = WORD_RANGES[lengthOption];
        lengthInstruction = `- Keep the article between ${minW} and ${maxW} words.\n`;
      } else {
        lengthInstruction = '- Aim for a concise, timely report (~900 words).\n';
      }

      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';

      const articlePrompt = `
You are a professional news reporter writing a fast-turnaround article about "${title}".

Do NOT include the title or any <h1> tag in the HTML output.

${reportingBlock}

${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${customInstructionBlock}  - Synthesize the developments from the listed sources into a cohesive news article.
  - Attribute key facts to the appropriate source by linking the relevant URL directly in the text.
  - Clearly indicate the timing of significant events and why they matter now.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}  - Do NOT invent sources or information not present in the listed reporting.

Write the full article in valid HTML below:
`.trim();

      const [minBound] = getWordBounds(lengthOption, customSections);
      const minWords =
        !lengthOption || lengthOption === 'default'
          ? Math.min(minBound, 900)
          : minBound;
      const maxTokens = Math.min(baseMaxTokens, 4000);

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        linkSources,
        systemPrompt,
        minLinks,
        maxTokens,
        minWords
      );

      return NextResponse.json({
        content,
        sources: newsSources,
      });
    }

    const reportingSources = serpEnabled
      ? await fetchSources(title, newsFreshness)
      : [];
    const reportingBlock = buildRecentReportingBlock(reportingSources);
    const groundingInstruction = reportingSources.length
      ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\n'
      : '';
    const linkSources = reportingSources.map((item) => item.url).filter(Boolean);

    // ─── Listicle/Gallery ────────────────────────────────────────────────────────
    if (articleType === 'Listicle/Gallery') {
      const match = title.match(/\d+/);
      const count = match ? parseInt(match[0], 10) : 5;

      const outlinePrompt = `
You are a professional writer.
Create an outline for a listicle titled "${title}".
Use exactly ${count} items.
Number each heading formatted like ${listNumberingFormat}.
List only the headings (no descriptions).
`.trim();

      const outlineRes = await openai.chat.completions.create({
        model: modelVersion,
        messages: [{ role: 'user', content: outlinePrompt }],
        temperature: 0.7,
      });
      const outline = outlineRes.choices[0]?.message?.content?.trim();
      if (!outline) throw new Error('Outline generation failed');

      const lengthInstruction = `- Use exactly ${count} items.\n`;
      const numberingInstruction = listNumberingFormat
        ? `- Use numbering formatted like ${listNumberingFormat}.\n`
        : '';
      const wordCountInstruction =
        listItemWordCount
          ? `- Keep each list item around ${listItemWordCount} words.\n`
          : '';
      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const minLinks = Math.min(MIN_LINKS, linkSources.length); // how many links to require
      const linkInstruction = linkSources.length
        ? `- Integrate clickable HTML links for every one of the following sources into relevant keywords or phrases.\n${linkSources
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
        : '';
      const toneChoice =
        toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
      const toneInstruction = toneChoice
        ? `- Write in a ${toneChoice} tone of voice.\n`
        : '';
      const povInstruction = pointOfView
        ? `- Use a ${pointOfView} perspective.\n`
        : '';

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = `
You are a professional journalist writing a listicle-style web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${numberingInstruction}${wordCountInstruction}${customInstructionBlock}  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const wordsPerItem = listItemWordCount || 100;
      const desired = count * wordsPerItem + 50;
      let maxTokens = Math.ceil((desired * 1.2) / 0.75); // add 20% buffer
      const limit = MODEL_CONTEXT_LIMITS[modelVersion] || 8000;
      maxTokens = Math.min(maxTokens, limit);
      const minWords = Math.floor(count * wordsPerItem * 0.8);

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        linkSources,
        systemPrompt,
        minLinks,
        maxTokens,
        minWords
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── YouTube Transcript → Blog ─────────────────────────────────────────────
    if (articleType === 'YouTube video to blog post') {
      const transcript = await fetchTranscript(videoLink || '');
      const transcriptInstruction = transcript
        ? `- Use the following transcript as source material:\n\n${transcript}\n\n`
        : `- Use the transcript from this video link as source material: ${videoLink}\n`;
      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const minLinks = Math.min(MIN_LINKS, linkSources.length); // how many links to require
      const linkInstruction = linkSources.length
        ? `- Integrate clickable HTML links for every one of the following sources into relevant keywords or phrases.\n${linkSources
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
        : '';

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = `
You are a professional journalist writing a web article from a YouTube transcript.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

${transcriptInstruction}${reportingSection}${toneInstruction}${povInstruction}Requirements:
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        linkSources,
        systemPrompt,
        minLinks,
        baseMaxTokens
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── Rewrite blog post ──────────────────────────────────────────────────────
    if (articleType === 'Rewrite blog post') {
      const maxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);
      const sourceText = await summarizeBlogContent(
        blogLink || '',
        useSummary,
        modelVersion
      );

      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const minLinks = Math.min(MIN_LINKS, linkSources.length); // how many links to require
    const linkInstruction = linkSources.length
      ? `- Integrate clickable HTML links for every one of the following sources into relevant keywords or phrases.\n${linkSources
          .map((u) => `  - ${u}`)
          .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
      : '';
      const rewriteInstruction = sourceText
        ? `- Rewrite the following content completely to avoid plagiarism:\n\n${sourceText}\n\n`
        : `- Rewrite the blog post at this URL completely to avoid plagiarism: ${blogLink}\n`;

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      let lengthInstruction: string;
      if (lengthOption === 'default') {
        lengthInstruction =
          `- Aim for around 9 sections (~${DEFAULT_WORDS.toLocaleString()} words total, ~220 words per section), but feel free to adjust based on the topic.\n`;
      } else if (lengthOption === 'custom' && customSections) {
        const approx = customSections * 220;
        lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
      } else if (WORD_RANGES[lengthOption || 'medium']) {
        const [minW, maxW] = WORD_RANGES[lengthOption || 'medium'];
        const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
        lengthInstruction =
          `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
      } else {
        lengthInstruction =
          '- Aim for around 9 sections (~1,900 words total, ~220 words per section), but feel free to adjust based on the topic.\n';
      }

      const articlePrompt = `
You are a professional journalist rewriting an existing blog post into a fresh, original article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

${rewriteInstruction}${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Begin with a 2–3 sentence introduction (no <h2> tags).
  - Organize the article with <h2> headings similar to the original structure.
  - Under each <h2>, write 2–3 paragraphs.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        linkSources,
        systemPrompt,
        minLinks,
        maxTokens,
        getWordBounds(lengthOption, customSections)[0]
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    // ─── Blog post (default) ───────────────────────────────────────────────────
    let sectionInstruction: string;
    if (lengthOption === 'default') {
      sectionInstruction = 'Include around 9 <h2> headings.';
    } else if (lengthOption === 'custom' && customSections) {
      sectionInstruction = `Use exactly ${customSections} <h2> headings.`;
    } else if (sectionRanges[lengthOption || 'medium']) {
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      sectionInstruction =
        `Include ${minS}–${maxS} <h2> headings.`;
    } else {
      sectionInstruction = 'Include at least three <h2> headings.';
    }

    const references =
      linkSources.length > 0
        ? `• Use these references:\n${linkSources
            .map((u) => `- ${u}`)
            .join('\n')}`
        : '';

    const baseOutline = `
You are a professional writer.

Create a detailed outline for an article titled:
"${title}"

• Begin with a section labeled "INTRO:" and include a single bullet with a 2–3 sentence introduction (no <h2>).
• After the "INTRO:" section, ${sectionInstruction}.
• Under each <h2>, list 2–3 bullet-point subtopics.
• Do NOT use "Introduction" or "Intro" as an <h2> heading.
• Do NOT use "Conclusion" or "Bottom line" as an <h2> heading.
${references}
`.trim();

    const outlineRes = await openai.chat.completions.create({
      model: modelVersion,
      messages: [{ role: 'user', content: baseOutline }],
      temperature: 0.7,
    });
    const outline = outlineRes.choices[0]?.message?.content?.trim();
    if (!outline) throw new Error('Outline generation failed');

    const customInstruction = customInstructions?.trim();
    const customInstructionBlock = customInstruction
      ? `- ${customInstruction}\n`
      : '';
    let lengthInstruction: string;
    if (lengthOption === 'default') {
      lengthInstruction =
        `- Aim for around 9 sections (~${DEFAULT_WORDS.toLocaleString()} words total, ~220 words per section), ` +
        'but feel free to adjust based on the topic.\n';
    } else if (lengthOption === 'custom' && customSections) {
      const approx = customSections * 220;
      lengthInstruction = `- Use exactly ${customSections} sections (~${approx} words total).\n`;
    } else if (WORD_RANGES[lengthOption || 'medium']) {
      const [minW, maxW] = WORD_RANGES[lengthOption || 'medium'];
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      lengthInstruction =
        `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
    } else {
      lengthInstruction =
        '- Aim for around 9 sections (~1,900 words total, ~220 words per section), but feel free to adjust based on the topic.\n';
    }

    const minLinks = Math.min(MIN_LINKS, linkSources.length); // how many links to require
    const linkInstruction = linkSources.length
      ? `- Integrate clickable HTML links for every one of the following sources into relevant keywords or phrases.\n${linkSources
          .map((u) => `  - ${u}`)
          .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
      : '';

    const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

    const articlePrompt = `
You are a professional journalist writing a web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${groundingInstruction}${customInstructionBlock}${linkInstruction}
  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Output raw HTML only:
`.trim();

    const content = await generateWithLinks(
      articlePrompt,
      modelVersion,
      linkSources,
      systemPrompt,
      minLinks,
      baseMaxTokens,
      getWordBounds(lengthOption, customSections)[0]
    );
    return NextResponse.json({
      content,
      sources: linkSources,
    });
  } catch (err: any) {
    console.error('[api/generate] error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal error' },
      { status: 500 }
    );
  }
}
