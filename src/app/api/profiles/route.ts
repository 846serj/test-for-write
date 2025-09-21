import { NextRequest, NextResponse } from 'next/server';
import { openai } from '../../../lib/openai';
import { supabaseAdmin } from '../../../lib/supabaseAdmin';
import {
  buildProfileHeadlineQuery,
  getProfileQuotaTotal,
  normalizeProfile,
  normalizeSiteUrl,
} from '../../../utils/profile';
import { NormalizedSiteProfile } from '../../../types/profile';

const EXTRACTION_PROMPT =
  'From the following user text, extract: language, taxonomy (IAB/IPTC-like tags), must_include_keywords, nice_to_have_keywords, must_exclude_keywords, entities_focus, audience, tone, and a per-category quota summing to 50 headlines. Return valid JSON.';

const MODEL = process.env.HEADLINE_PROFILE_MODEL || 'gpt-4o-mini';

type PostBody = {
  userId?: string;
  siteUrl?: string;
  rawText?: string;
};

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function extractProfile(rawText: string): Promise<NormalizedSiteProfile> {
  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You turn unstructured editorial briefs into consistent JSON site profiles that downstream services can consume.',
      },
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\n${rawText}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Model returned no content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Model response was not valid JSON');
  }

  return normalizeProfile(parsed);
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) {
    return jsonError('Missing userId');
  }

  const { data, error } = await supabaseAdmin
    .from('site_profiles')
    .select('site_url, raw_text, profile')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[profiles] failed to load profile', error);
    return jsonError('Failed to load profile', 500);
  }

  if (!data) {
    return NextResponse.json({ profile: null });
  }

  let normalizedProfile: NormalizedSiteProfile;
  try {
    normalizedProfile = normalizeProfile(data.profile);
  } catch (error) {
    console.error('[profiles] stored profile invalid', error);
    return NextResponse.json({ profile: null });
  }

  return NextResponse.json({
    profile: normalizedProfile,
    siteUrl: data.site_url,
    rawText: data.raw_text,
    headlineQuery: buildProfileHeadlineQuery(normalizedProfile),
    quotaTotal: getProfileQuotaTotal(normalizedProfile),
  });
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body');
  }

  const userId = body.userId?.trim();
  const siteUrlRaw = body.siteUrl?.trim();
  const rawText = body.rawText?.trim();

  if (!userId) {
    return jsonError('Missing userId');
  }
  if (!siteUrlRaw) {
    return jsonError('Missing siteUrl');
  }
  if (!rawText) {
    return jsonError('Missing profile text');
  }

  let normalizedSiteUrl: string;
  try {
    normalizedSiteUrl = normalizeSiteUrl(siteUrlRaw);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Invalid site URL provided'
    );
  }

  let profile: NormalizedSiteProfile;
  try {
    profile = await extractProfile(rawText);
  } catch (error) {
    console.error('[profiles] extraction failed', error);
    return jsonError(
      error instanceof Error ? error.message : 'Failed to normalize profile',
      502
    );
  }

  const payload = {
    user_id: userId,
    site_url: normalizedSiteUrl,
    raw_text: rawText,
    profile,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('site_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('site_url, raw_text, profile')
    .single();

  if (error) {
    const supabaseError = {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    };

    console.error('[profiles] failed to store profile', {
      context: {
        userId,
        siteUrl: normalizedSiteUrl,
        rawTextLength: rawText.length,
      },
      supabaseError,
    });

    const errorBody: Record<string, unknown> = { error: 'Failed to store profile' };
    if (process.env.NODE_ENV !== 'production') {
      errorBody.supabase = supabaseError;
    }

    return NextResponse.json(errorBody, { status: 500 });
  }

  const normalizedProfile = normalizeProfile(data.profile);

  return NextResponse.json({
    profile: normalizedProfile,
    siteUrl: data.site_url,
    rawText: data.raw_text,
    headlineQuery: buildProfileHeadlineQuery(normalizedProfile),
    quotaTotal: getProfileQuotaTotal(normalizedProfile),
  });
}
