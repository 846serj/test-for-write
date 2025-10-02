import type { TravelPreset } from '../travelPresets';

type TravelPresetResponse = {
  preset: TravelPreset;
};

const presetCache = new Map<string, Promise<TravelPreset>>();

function normalizeState(state: string | null | undefined): string {
  if (typeof state !== 'string') {
    return '';
  }
  const trimmed = state.trim().toLowerCase();
  return trimmed;
}

async function requestPreset(state: string): Promise<TravelPreset> {
  const query = state ? `?state=${encodeURIComponent(state)}` : '';
  const response = await fetch(`/api/travel-presets${query}`);
  if (!response.ok) {
    throw new Error(`Failed to load travel preset (${response.status})`);
  }

  const data = (await response.json()) as TravelPresetResponse;
  if (!data || typeof data !== 'object' || !data.preset) {
    throw new Error('Travel preset response missing payload');
  }

  return data.preset;
}

export function clearTravelPresetCache() {
  presetCache.clear();
}

export function primeTravelPresetCache(
  state: string | null | undefined,
  preset: TravelPreset
) {
  const key = normalizeState(state) || '__default__';
  presetCache.set(key, Promise.resolve(preset));
}

export async function fetchTravelPreset(
  state: string | null | undefined
): Promise<TravelPreset> {
  const key = normalizeState(state) || '__default__';
  if (!presetCache.has(key)) {
    presetCache.set(key, requestPreset(key === '__default__' ? '' : key));
  }
  return presetCache.get(key)!;
}
