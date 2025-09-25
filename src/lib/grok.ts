type GrokChatCompletionOptions = {
  prompt: string;
  model?: string;
  temperature?: number;
};

const DEFAULT_GROK_MODEL = 'grok-4';

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
}: GrokChatCompletionOptions): Promise<string> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GROK_API_KEY');
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
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
  });

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

