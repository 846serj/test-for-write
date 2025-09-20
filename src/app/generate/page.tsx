// page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';
import clsx from 'clsx';
import { DEFAULT_WORDS, WORD_RANGES } from '../../constants/lengthOptions';

type HeadlineItem = {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  description?: string;
};

export default function GeneratePage() {
  const router = useRouter();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeTab, setActiveTab] = useState<'writing' | 'headlines'>('writing');

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    const defaultTheme = savedTheme || 'light';
    setTheme(defaultTheme);
    document.documentElement.classList.toggle('dark', defaultTheme === 'dark');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
    localStorage.setItem('theme', newTheme);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/auth');
  };

  const [title, setTitle] = useState('');
  const [articleType, setArticleType] = useState<
    | 'Blog post'
    | 'Listicle/Gallery'
    | 'YouTube video to blog post'
    | 'Rewrite blog post'
    | 'Recipe article'
    | 'News article'
  >('Blog post');

  // for blog‐post & rewrite
  const [lengthOption, setLengthOption] = useState<
    | 'default'
    | 'custom'
    | 'shorter'
    | 'short'
    | 'medium'
    | 'longForm'
    | 'longer'
  >('default');
  const [customSections, setCustomSections] = useState<number>(5);

  const [customInstructions, setCustomInstructions] = useState('');
  const [loading, setLoading] = useState(false);
  const [headlinePrompt, setHeadlinePrompt] = useState('');
  const [headlineLimit, setHeadlineLimit] = useState<number>(5);
  const [headlineLoading, setHeadlineLoading] = useState(false);
  const [headlineError, setHeadlineError] = useState<string | null>(null);
  const [headlineResults, setHeadlineResults] = useState<HeadlineItem[]>([]);

  // YouTube link
  const [videoLink, setVideoLink] = useState('');

  // Rewrite link
  const [blogLink, setBlogLink] = useState('');
  const [useSummary, setUseSummary] = useState<boolean>(false);

  // Tone of Voice
  const [toneOfVoice, setToneOfVoice] = useState<
    | 'SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)'
    | 'Excited'
    | 'Professional'
    | 'Friendly'
    | 'Formal'
    | 'Casual'
    | 'Humorous'
    | 'Custom'
  >('SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)');
  const [customTone, setCustomTone] = useState<string>('');

  // Point of View
  const [pointOfView, setPointOfView] = useState<
    | 'First Person Singular'
    | 'First Person Plural'
    | 'Second Person'
    | 'Third Person'
  >('First Person Singular');

  // Listicle/Recipe fields
  const [numberingFormat, setNumberingFormat] = useState<
    | '1), 2), 3)'
    | '1., 2., 3.'
    | '1:, 2:, 3:'
    | 'None'
  >('1), 2), 3)');
  const [itemWordCount, setItemWordCount] = useState<number>(100);
  const [recipeItemCount, setRecipeItemCount] = useState<number>(5);

  // ─── NEW: MODEL VERSION ───────────────────────────────────────────────────────
  const models = ['gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
  const [modelVersion, setModelVersion] = useState<string>(models[0]);
  const [useSerpApi, setUseSerpApi] = useState<boolean>(true);
  const [includeLinks, setIncludeLinks] = useState<boolean>(true);
  const [newsFreshness, setNewsFreshness] = useState<'1h' | '6h' | '24h'>('6h');

  useEffect(() => {
    if (activeTab !== 'headlines') {
      setHeadlineLoading(false);
      setHeadlineError(null);
    }
  }, [activeTab]);

  const handleGenerate = async () => {
    if (!title.trim()) {
      alert('Enter a title first');
      return;
    }
    if (articleType === 'Rewrite blog post' && !blogLink.trim()) {
      alert('Enter a blog post URL to rewrite');
      return;
    }
    if (
      (articleType === 'Blog post' || articleType === 'Rewrite blog post') &&
      lengthOption === 'custom' &&
      customSections < 1
    ) {
      alert('Enter a valid number of sections');
      return;
    }
    if (articleType === 'YouTube video to blog post' && !videoLink.trim()) {
      alert('Enter a YouTube video link');
      return;
    }
    if (articleType === 'Recipe article' && recipeItemCount < 1) {
      alert('Enter a valid number of recipes');
      return;
    }

    setLoading(true);
    try {
      const instructions = customInstructions.trim();

      const payload: any = {
        title,
        articleType,
        newsFreshness,
        ...(instructions && { customInstructions: instructions }),
        toneOfVoice,
        ...(toneOfVoice === 'Custom' && { customTone }),
        pointOfView,
        modelVersion,
        useSerpApi,
        includeLinks,
      };

      if (articleType === 'Listicle/Gallery') {
        payload.listNumberingFormat = numberingFormat;
        payload.listItemWordCount = itemWordCount;
      } else if (articleType === 'Recipe article') {
        payload.numberingFormat = numberingFormat;
        payload.wordsPerItem = itemWordCount;
        payload.itemCount = recipeItemCount;
      } else if (articleType === 'YouTube video to blog post') {
        payload.videoLink = videoLink;
      } else if (articleType === 'Rewrite blog post') {
        payload.blogLink = blogLink;
        payload.useSummary = useSummary;
        payload.lengthOption = lengthOption;
        payload.customSections =
          lengthOption === 'custom' ? customSections : undefined;
      } else {
        payload.lengthOption = lengthOption;
        payload.customSections =
          lengthOption === 'custom' ? customSections : undefined;
      }

      // Save payload for future regeneration
      try {
        localStorage.setItem('lastPrompt', JSON.stringify(payload));
      } catch {}

      const url =
        articleType === 'Recipe article' ? '/api/generate-recipe' : '/api/generate';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.content) {
        alert(
          `Failed to generate article: ${
            data.error || res.statusText || 'no content returned'
          }${data.airtableError ? ` - ${data.airtableError}` : ''}`
        );
        return;
      }

      try {
        localStorage.setItem('lastArticleContent', data.content);
        localStorage.setItem(
          'lastArticleSources',
          JSON.stringify(data.sources || [])
        );
      } catch {}

      router.push(`/editor?title=${encodeURIComponent(title)}`);
    } catch (err) {
      console.error('[generate] fetch error:', err);
      alert('Error generating article — check console');
    } finally {
      setLoading(false);
    }
  };

  const handleFetchHeadlines = async () => {
    if (!headlinePrompt.trim()) {
      setHeadlineError('Please describe the article to fetch headlines.');
      return;
    }

    setHeadlineLoading(true);
    setHeadlineError(null);

    try {
      const response = await fetch('/api/headlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: headlinePrompt.trim(),
          limit: headlineLimit,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error || response.statusText || 'Failed to fetch headlines'
        );
      }

      const rawHeadlines = Array.isArray(data?.headlines)
        ? data.headlines
        : Array.isArray(data?.results)
        ? data.results
        : null;

      if (!rawHeadlines) {
        throw new Error('Invalid response from server');
      }

      const normalized: HeadlineItem[] = rawHeadlines.map((item: any) => ({
        title: item.title ?? '',
        source:
          typeof item.source === 'string'
            ? item.source
            : item.source?.name ?? item.source?.title ?? '',
        url: item.url ?? item.link ?? item.href ?? '',
        publishedAt: item.publishedAt ?? item.published_at ?? '',
        description: item.description ?? item.summary ?? '',
      }));

      setHeadlineResults(normalized);
    } catch (error: any) {
      console.error('[headlines] fetch error:', error);
      setHeadlineError(error?.message || 'Unable to fetch headlines.');
      setHeadlineResults([]);
    } finally {
      setHeadlineLoading(false);
    }
  };

  const labelStyle = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const inputStyle =
    'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-black dark:text-white rounded-md px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div
      className={clsx(
        'min-h-screen transition-colors',
        theme === 'dark' ? 'bg-gray-900 text-white' : 'bg-gray-50 text-black'
      )}
    >
      {/* TOP BAR */}
      <div className="w-full px-6 py-4 flex justify-between items-center bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-xl font-semibold">Generate New Article</h1>
        <div className="flex space-x-2">
          <button
            onClick={toggleTheme}
            className="text-sm border border-gray-400 dark:border-gray-600 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
          </button>
          <button
            onClick={handleSignOut}
            className="bg-red-500 text-white px-4 py-2 rounded"
          >
            Sign Out
          </button>
        </div>
      </div>

      <div className="w-full px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex space-x-2">
          <button
            onClick={() => setActiveTab('writing')}
            className={clsx(
              'px-4 py-2 rounded-md text-sm font-medium transition-colors',
              activeTab === 'writing'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            )}
          >
            Writing
          </button>
          <button
            onClick={() => setActiveTab('headlines')}
            className={clsx(
              'px-4 py-2 rounded-md text-sm font-medium transition-colors',
              activeTab === 'headlines'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            )}
          >
            Headlines
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {activeTab === 'writing' ? (
          <div className="space-y-6 bg-white dark:bg-gray-800 shadow-md rounded-lg p-6">
          {/* TITLE */}
          <div>
            <label className={labelStyle}>Title</label>
            <input
              type="text"
              className={inputStyle}
              placeholder="Enter article title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* ARTICLE TYPE */}
          <div>
            <label className={labelStyle}>Article Type</label>
            <select
              className={inputStyle}
              value={articleType}
              onChange={(e) => setArticleType(e.target.value as any)}
            >
              <option value="Blog post">Blog post</option>
              <option value="Listicle/Gallery">Listicle/Gallery</option>
              <option value="Recipe article">Recipe article</option>
              <option value="YouTube video to blog post">
                YouTube video to blog post
              </option>
              <option value="Rewrite blog post">Rewrite blog post</option>
              <option value="News article">News article</option>
            </select>
          </div>

          {articleType === 'News article' && (
            <div>
              <label className={labelStyle}>News Freshness</label>
              <select
                className={inputStyle}
                value={newsFreshness}
                onChange={(e) =>
                  setNewsFreshness(e.target.value as '1h' | '6h' | '24h')
                }
              >
                <option value="1h">Past hour</option>
                <option value="6h">Past 6 hours</option>
                <option value="24h">Past 24 hours</option>
              </select>
            </div>
          )}

          {/* CUSTOM INSTRUCTIONS */}
          <div>
            <label className={labelStyle}>Custom Instructions (optional)</label>
            <textarea
              className={inputStyle}
              rows={3}
              placeholder="Any additional guidance for the article"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
            />
          </div>

          {/* NUMBERING FORMAT */}
          {(articleType === 'Listicle/Gallery' || articleType === 'Recipe article') && (
            <div>
              <label className={labelStyle}>Numbering Format</label>
              <select
                className={clsx(inputStyle, 'mb-2')}
                value={numberingFormat}
                onChange={(e) => setNumberingFormat(e.target.value as any)}
              >
                <option value="1), 2), 3)">1), 2), 3)</option>
                <option value="1., 2., 3.">1., 2., 3.</option>
                <option value="1:, 2:, 3:">1:, 2:, 3:</option>
                <option value="None">None</option>
              </select>
            </div>
          )}

          {/* MAIN INPUT: scenarios */}
          {articleType === 'Listicle/Gallery' ? (
            <div>
              <div className="mt-2 flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Words per item</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={itemWordCount}
                  onChange={(e) => setItemWordCount(Number(e.target.value))}
                />
              </div>
            </div>
          ) : articleType === 'Recipe article' ? (
            <div>
              <div className="flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Number of recipes</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={recipeItemCount}
                  onChange={(e) => setRecipeItemCount(Number(e.target.value))}
                />
              </div>
              <div className="mt-2 flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Words per item</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={itemWordCount}
                  onChange={(e) => setItemWordCount(Number(e.target.value))}
                />
              </div>
            </div>
          ) : articleType === 'YouTube video to blog post' ? (
            <div>
              <label className={labelStyle}>YouTube Video Link</label>
              <input
                type="text"
                className={inputStyle}
                placeholder="https://youtube.com/..."
                value={videoLink}
                onChange={(e) => setVideoLink(e.target.value)}
              />
            </div>
          ) : articleType === 'Rewrite blog post' ? (
            <>
              <div>
                <label className={labelStyle}>Blog Post URL</label>
                <input
                  type="text"
                  className={inputStyle}
                  placeholder="https://example.com/your-post"
                  value={blogLink}
                  onChange={(e) => setBlogLink(e.target.value)}
                />
                <div className="flex items-center mt-2">
                  <input
                    id="use-summary"
                    type="checkbox"
                    checked={useSummary}
                    onChange={(e) => setUseSummary(e.target.checked)}
                    className="mr-2 h-4 w-4"
                  />
                  <label
                    htmlFor="use-summary"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Summarize source before rewriting
                  </label>
                </div>
              </div>
              <div>
                <label className={labelStyle}>Article Length / Sections</label>
                <select
                  className={clsx(inputStyle, 'mb-2')}
                  value={lengthOption}
                  onChange={(e) => setLengthOption(e.target.value as any)}
                >
                  <option value="default">
                    Default (AI chooses ~9 sections / ~{DEFAULT_WORDS.toLocaleString()} words)
                  </option>
                  <option value="custom">Custom Number of Sections</option>
                  <option value="shorter">Shorter (2–3 sections, {WORD_RANGES.shorter[0]}–{WORD_RANGES.shorter[1]} words)</option>
                  <option value="short">Short (3–5 sections, {WORD_RANGES.short[0]}–{WORD_RANGES.short[1]} words)</option>
                  <option value="medium">Medium (5–7 sections, {WORD_RANGES.medium[0]}–{WORD_RANGES.medium[1]} words)</option>
                  <option value="longForm">
                    Long Form (7–10 sections, {WORD_RANGES.longForm[0]}–{WORD_RANGES.longForm[1]} words)
                  </option>
                  <option value="longer">
                    Longer (10–12 sections, {WORD_RANGES.longer[0]}–{WORD_RANGES.longer[1]} words)
                  </option>
                </select>
                {lengthOption === 'default' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                  AI will choose how comprehensive the article should be (~9 sections /
                    {DEFAULT_WORDS.toLocaleString()} words avg).
                  </p>
                )}
                {lengthOption === 'custom' && (
                  <div className="mt-2">
                    <input
                      type="number"
                      min={1}
                      className={inputStyle + ' w-1/2'}
                      placeholder="Number of sections"
                      value={customSections}
                      onChange={(e) => setCustomSections(Number(e.target.value))}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div>
              <label className={labelStyle}>Article Length / Sections</label>
              <select
                className={clsx(inputStyle, 'mb-2')}
                value={lengthOption}
                onChange={(e) => setLengthOption(e.target.value as any)}
              >
                <option value="default">
                  Default (AI chooses ~9 sections / ~{DEFAULT_WORDS.toLocaleString()} words)
                </option>
                <option value="custom">Custom Number of Sections</option>
                <option value="shorter">Shorter (2–3 sections, {WORD_RANGES.shorter[0]}–{WORD_RANGES.shorter[1]} words)</option>
                <option value="short">Short (3–5 sections, {WORD_RANGES.short[0]}–{WORD_RANGES.short[1]} words)</option>
                <option value="medium">Medium (5–7 sections, {WORD_RANGES.medium[0]}–{WORD_RANGES.medium[1]} words)</option>
                <option value="longForm">
                  Long Form (7–10 sections, {WORD_RANGES.longForm[0]}–{WORD_RANGES.longForm[1]} words)
                </option>
                <option value="longer">
                  Longer (10–12 sections, {WORD_RANGES.longer[0]}–{WORD_RANGES.longer[1]} words)
                </option>
              </select>
              {lengthOption === 'default' && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  AI will choose how comprehensive the article should be (~9 sections /
                  {DEFAULT_WORDS.toLocaleString()} words avg).
                </p>
              )}
              {lengthOption === 'custom' && (
                <div className="mt-2">
                  <input
                    type="number"
                    min={1}
                    className={inputStyle + ' w-1/2'}
                    placeholder="Number of sections"
                    value={customSections}
                    onChange={(e) => setCustomSections(Number(e.target.value))}
                  />
                </div>
              )}
            </div>
          )}

          {/* TONE OF VOICE */}
          <div>
            <label className={labelStyle}>Tone of Voice</label>
            <select
              className={clsx(inputStyle, 'mb-2')}
              value={toneOfVoice}
              onChange={(e) => setToneOfVoice(e.target.value as any)}
            >
              <option value="SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)">
                SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)
              </option>
              <option value="Excited">Excited</option>
              <option value="Professional">Professional</option>
              <option value="Friendly">Friendly</option>
              <option value="Formal">Formal</option>
              <option value="Casual">Casual</option>
              <option value="Humorous">Humorous</option>
              <option value="Custom">Custom</option>
            </select>
            {toneOfVoice === 'Custom' && (
              <input
                type="text"
                className={inputStyle + ' mt-2'}
                placeholder="Enter custom tone"
                value={customTone}
                onChange={(e) => setCustomTone(e.target.value)}
              />
            )}
          </div>

          {/* POINT OF VIEW */}
          <div>
            <label className={labelStyle}>Point of View</label>
            <select
              className={clsx(inputStyle, 'mb-2')}
              value={pointOfView}
              onChange={(e) => setPointOfView(e.target.value as any)}
            >
              <option value="First Person Singular">
                First Person Singular (I, me, my, mine)
              </option>
              <option value="First Person Plural">
                First Person Plural (we, us, our, ours)
              </option>
              <option value="Second Person">Second Person (you, your, yours)</option>
              <option value="Third Person">
                Third Person (he, she, it, they)
              </option>
            </select>
          </div>

          {/* USE SERP API */}
          <div className="flex items-center">
          <input id="use-serp-api" type="checkbox" checked={useSerpApi} onChange={(e) => setUseSerpApi(e.target.checked)} className="mr-2 h-4 w-4" />
          <label htmlFor="use-serp-api" className="text-sm font-medium text-gray-700 dark:text-gray-300">Use SERP API for sources</label>
        </div>
        <div className="flex items-center">
          <input
            id="include-links"
            type="checkbox"
            checked={includeLinks}
            onChange={(e) => setIncludeLinks(e.target.checked)}
            className="mr-2 h-4 w-4"
          />
          <label htmlFor="include-links" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Include links in article
          </label>
        </div>
          {/* ─── MODEL VERSION ─────────────────────────────────────────────────────── */}
          <div>
            <label className={labelStyle}>Model Version</label>
            <div className="flex space-x-2">
              {models.map((m) => (
                <button
                  key={m}
                  onClick={() => setModelVersion(m)}
                  className={clsx(
                    'px-3 py-1 rounded-md border',
                    modelVersion === m
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 border-gray-300 dark:border-gray-600'
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* GENERATE BUTTON */}
          <div className="pt-4">
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow"
            >
              {loading ? 'Generating…' : 'Generate & Edit'}
            </button>
          </div>
          </div>
        ) : (
          <div className="space-y-6 bg-white dark:bg-gray-800 shadow-md rounded-lg p-6">
            <div>
              <label className={labelStyle}>Article Description</label>
              <textarea
                className={inputStyle}
                rows={4}
                placeholder="Describe the article to fetch relevant headlines"
                value={headlinePrompt}
                onChange={(e) => setHeadlinePrompt(e.target.value)}
              />
            </div>

            <div>
              <label className={labelStyle}>Number of Headlines</label>
              <input
                type="number"
                min={1}
                max={50}
                className={clsx(inputStyle, 'w-32')}
                value={headlineLimit}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  const clamped = Math.min(50, Math.max(1, Number.isNaN(value) ? 1 : value));
                  setHeadlineLimit(clamped);
                }}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Choose between 1 and 50 headlines.
              </p>
            </div>

            <div className="pt-2">
              <button
                onClick={handleFetchHeadlines}
                disabled={headlineLoading || !headlinePrompt.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {headlineLoading ? 'Fetching…' : 'Fetch Headlines'}
              </button>
            </div>

            {headlineError && (
              <p className="text-sm text-red-500" role="alert">
                {headlineError}
              </p>
            )}

            {headlineLoading && !headlineError && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Fetching headlines…
              </p>
            )}

            {!headlineLoading && !headlineError && headlineResults.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Headlines will appear here after fetching.
              </p>
            )}

            {headlineResults.length > 0 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Headlines</h2>
                <ul className="space-y-4">
                  {headlineResults.map((headline, index) => {
                    const headlineUrl = headline.url;
                    return (
                      <li
                        key={headlineUrl || index}
                        className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900"
                      >
                        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                          {headline.title || 'Untitled headline'}
                        </h3>
                        {(headline.source || headline.publishedAt) && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            {headline.source && <span>Source: {headline.source}</span>}
                            {headline.source && headline.publishedAt && <span className="mx-2">•</span>}
                            {headline.publishedAt && <span>Published: {headline.publishedAt}</span>}
                          </p>
                        )}
                        {headline.description && (
                          <p className="text-sm text-gray-700 dark:text-gray-300 mt-2">
                            {headline.description}
                          </p>
                        )}
                        {headlineUrl && (
                          <a
                            href={headlineUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 dark:text-blue-400 mt-3 inline-block"
                          >
                            Read more
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
