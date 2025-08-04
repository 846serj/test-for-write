// route.ts
import { NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import { DEFAULT_WORDS, WORD_RANGES } from '../../../constants/lengthOptions';

export const runtime = 'edge';
export const revalidate = 0;

interface SerpApiResponse {
  organic_results?: { link: string }[];
  news_results?: { link: string }[];
  scholar_results?: { link: string }[];
  error?: string;
}

const sectionRanges: Record<string, [number, number]> = {
  shorter: [2, 4],
  short: [3, 5],
  medium: [4, 6],
  longForm: [5, 7],
  longer: [6, 8],
};

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

async function serpapiSearch(q: string, engine: string): Promise<string[]> {
  try {
    const url =
      `https://serpapi.com/search.json?` +
      `q=${encodeURIComponent(q)}&engine=${engine}&api_key=${process.env.SERPAPI_KEY}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) return [];
    const data = (await resp.json()) as SerpApiResponse;
    if (data.error) return [];
    const hits =
      data.organic_results || data.news_results || data.scholar_results || [];
    return hits.map((h) => h.link).slice(0, 5);
  } catch {
    return [];
  }
}

async function fetchSources(headline: string): Promise<string[]> {
  const [g, n, s] = await Promise.all([
    serpapiSearch(headline, 'google'),
    serpapiSearch(headline, 'google_news'),
    serpapiSearch(headline, 'google_scholar'),
  ]);
  const unique = Array.from(new Set([...g, ...n, ...s]));
  // Shuffle the unique links
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, 5);
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

// Generate article content and ensure a minimum number of links are present
// prompt   - text prompt to send to the model
// model    - model name to use
// sources  - list of source URLs that may be linked
// minLinks - minimum number of <a href> links required in the output
async function generateWithLinks(
  prompt: string,
  model: string,
  sources: string[],
  minLinks: number = MIN_LINKS,
  maxTokens = 2000,
  minWords = 0
): Promise<string> {
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  let tokens = Math.min(maxTokens, limit);
  let baseRes = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: tokens,
  });

  // If the response was cut off due to max_tokens, retry once with more room
  if (baseRes.choices[0]?.finish_reason === 'length' && tokens < limit) {
    tokens = Math.min(tokens * 2, limit);
    baseRes = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: tokens,
    });
  }

  let content = baseRes.choices[0]?.message?.content?.trim() || '';
  content = content
    .replace(/^```(?:html)?\n/i, '')
    .replace(/```$/i, '')
    .trim();
  const linkCount = content.match(/<a\s+href=/gi)?.length || 0;

  if (linkCount < minLinks && sources.length > 0) {
    const retryPrompt = `${prompt}\n\nYou forgot to include at least ${minLinks} links. Integrate at least ${minLinks} clickable HTML links from the provided sources using <a href="URL" target="_blank">text</a>.`;
    const retryRes = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: retryPrompt }],
      temperature: 0.7,
      max_tokens: tokens,
    });
    content = retryRes.choices[0]?.message?.content?.trim() || content;
    content = content
      .replace(/^```(?:html)?\n/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  if (minWords > 0) {
    const textOnly = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textOnly ? textOnly.split(/\s+/).length : 0;
    if (wordCount < minWords && tokens < limit) {
      tokens = Math.min(tokens * 2, limit);
      const expandPrompt = `${prompt}\n\nYour previous response was only ${wordCount} words. Expand it to at least ${minWords} words while keeping the same structure and links.`;
      const retryRes = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: expandPrompt }],
        temperature: 0.7,
        max_tokens: tokens,
      });
      content = retryRes.choices[0]?.message?.content?.trim() || content;
      content = content
        .replace(/^```(?:html)?\n/i, '')
        .replace(/```$/i, '')
        .trim();
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
    } = await request.json();

    if (!title?.trim()) {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 });
    }

    const serpEnabled = includeLinks && useSerpApi && !!process.env.SERPAPI_KEY;
    const sources = serpEnabled ? await fetchSources(title) : [];

    const baseMaxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);

    const toneChoice =
      toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
    const toneInstruction = toneChoice
      ? `- Write in a ${toneChoice} tone of voice.\n`
      : '';
    const povInstruction = pointOfView
      ? `- Use a ${pointOfView} perspective.\n`
      : '';

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
      const minLinks = Math.min(MIN_LINKS, sources.length); // how many links to require
      const linkInstruction = sources.length
        ? `- Integrate at least ${minLinks} clickable HTML links into relevant keywords or phrases.\n${sources
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

      const articlePrompt = `
You are a professional journalist writing a listicle-style web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${numberingInstruction}${wordCountInstruction}${customInstructionBlock}  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
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
        sources,
        minLinks,
        maxTokens,
        minWords
      );
      return NextResponse.json({
        content,
        sources,
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
      const minLinks = Math.min(MIN_LINKS, sources.length); // how many links to require
      const linkInstruction = sources.length
        ? `- Integrate at least ${minLinks} clickable HTML links into relevant keywords or phrases.\n${sources
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
        : '';

      const articlePrompt = `
You are a professional journalist writing a web article from a YouTube transcript.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

${transcriptInstruction}${toneInstruction}${povInstruction}Requirements:
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        sources,
        minLinks,
        baseMaxTokens
      );
      return NextResponse.json({
        content,
        sources,
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
      const minLinks = Math.min(MIN_LINKS, sources.length); // how many links to require
      const linkInstruction = sources.length
        ? `- Integrate at least ${minLinks} clickable HTML links into relevant keywords or phrases.\n${sources
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
        : '';
      const rewriteInstruction = sourceText
        ? `- Rewrite the following content completely to avoid plagiarism:\n\n${sourceText}\n\n`
        : `- Rewrite the blog post at this URL completely to avoid plagiarism: ${blogLink}\n`;

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

${rewriteInstruction}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Begin with a 2–3 sentence introduction (no <h2> tags).
  - Organize the article with <h2> headings similar to the original structure.
  - Under each <h2>, write 2–3 paragraphs.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const content = await generateWithLinks(
        articlePrompt,
        modelVersion,
        sources,
        minLinks,
        maxTokens,
        getWordBounds(lengthOption, customSections)[0]
      );
      return NextResponse.json({
        content,
        sources,
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
      sources.length > 0
        ? `• Use these references:\n${sources
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

    const minLinks = Math.min(MIN_LINKS, sources.length); // how many links to require
    const linkInstruction = sources.length
      ? `- Integrate at least ${minLinks} clickable HTML links into relevant keywords or phrases.\n${sources
          .map((u) => `  - ${u}`)
          .join('\n')}\n  - Embed each link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end. Spread the links naturally across the article.`
      : '';

    const articlePrompt = `
You are a professional journalist writing a web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${linkInstruction}
  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Output raw HTML only:
`.trim();

    const content = await generateWithLinks(
      articlePrompt,
      modelVersion,
      sources,
      minLinks,
      baseMaxTokens,
      getWordBounds(lengthOption, customSections)[0]
    );
    return NextResponse.json({
      content,
      sources,
    });
  } catch (err: any) {
    console.error('[api/generate] error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal error' },
      { status: 500 }
    );
  }
}
