import { getTravelPreset } from '../../../lib/travelPresets';

export async function handleTravelPresetRequest(state: string | null) {
  const preset = await getTravelPreset(state);
  return { preset };
}
