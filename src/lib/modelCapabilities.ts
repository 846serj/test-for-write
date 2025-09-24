const FIXED_TEMPERATURE_MODELS = new Set([
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
]);

export function supportsTemperature(model: string | undefined): boolean {
  if (!model) {
    return true;
  }
  return !FIXED_TEMPERATURE_MODELS.has(model);
}

export function withTemperature(
  model: string | undefined,
  temperature: number | undefined
): { temperature?: number } {
  if (typeof temperature !== 'number') {
    return {};
  }

  if (!supportsTemperature(model)) {
    return {};
  }

  return { temperature };
}
