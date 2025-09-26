type GrokChatCompletionOptions = {
  prompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
};

const DEFAULT_GROK_MODEL = process.env.GROK_MODEL ?? 'grok-3-mini';

interface GrokChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export async function grokChatCompletion({
  prompt,
  model = DEFAULT_GROK_MODEL,
  temperature = 0.7,
  timeoutMs = 25_000,
}: GrokChatCompletionOptions): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GROK_API_KEY');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Grok API request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Grok API request failed with status ${response.status}: ${message}`
    );
  }

  const data = (await response.json()) as GrokChatCompletionResponse;
  const outline = data.choices?.[0]?.message?.content?.trim();
  if (!outline) {
    throw new Error('Grok API returned no outline content');
  }

  return outline;
}

