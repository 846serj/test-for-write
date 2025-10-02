import { NextResponse } from 'next/server';

import { getTravelPreset } from '../../../lib/travelPresets';

export async function handleTravelPresetRequest(state: string | null) {
  const preset = await getTravelPreset(state);
  return { preset };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const stateParam = url.searchParams.get('state');

  try {
    const payload = await handleTravelPresetRequest(stateParam);
    return NextResponse.json(payload, { status: 200 });
  } catch (error: any) {
    console.error('[api/travel-presets] error:', error);
    return NextResponse.json(
      {
        error:
          error?.message || 'Failed to resolve travel presets for the destination.',
      },
      { status: 500 }
    );
  }
}
