import { NextResponse } from 'next/server';
import { fetchBlogContent, fetchTranscript } from '../../../lib/sourceContent';

export const runtime = 'edge';

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const { type, url } = payload ?? {};
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ ok: false, error: 'Missing URL' }, { status: 400 });
    }
    if (type === 'blog') {
      const content = await fetchBlogContent(url);
      return NextResponse.json({ ok: !!content });
    }
    if (type === 'transcript') {
      const content = await fetchTranscript(url);
      return NextResponse.json({ ok: !!content });
    }
    return NextResponse.json({ ok: false, error: 'Unsupported type' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'Prefetch failed' },
      { status: 500 }
    );
  }
}
