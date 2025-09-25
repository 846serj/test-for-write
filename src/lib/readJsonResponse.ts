export interface ParsedJsonResponse<T> {
  data: T | null;
  rawBody: string;
}

export async function readJsonResponse<T = any>(
  res: Response,
  context?: string
): Promise<ParsedJsonResponse<T>> {
  const rawBody = await res.text();
  if (!rawBody) {
    return { data: null, rawBody: '' };
  }

  try {
    return { data: JSON.parse(rawBody) as T, rawBody };
  } catch (error) {
    const prefix = context ? `[${context}]` : '[readJsonResponse]';
    console.error(
      `${prefix} failed to parse JSON response`,
      error,
      rawBody.slice(0, 200)
    );
    return { data: null, rawBody };
  }
}
