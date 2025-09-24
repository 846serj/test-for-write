export async function readJsonOrText(
  res: Response,
  contextLabel: string
): Promise<{ data: any; raw: string | null }> {
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    try {
      const data = await res.json();
      return { data, raw: null };
    } catch (err) {
      console.error(
        `[${contextLabel}] failed to parse JSON response`,
        err
      );
      throw new Error('Invalid JSON response from the server.');
    }
  }

  const raw = await res.text();
  return { data: null, raw };
}

export function summarizeRawResponse(raw: string | null): string | null {
  if (!raw) return null;

  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!sanitized) {
    return null;
  }

  return sanitized.slice(0, 200);
}
