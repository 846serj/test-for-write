const GROK_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

export type GrokChatCompletionMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface GrokChatCompletionRequest {
  model: string;
  messages: GrokChatCompletionMessage[];
  temperature?: number;
}

interface GrokChatCompletionChoice {
  message?: {
    role?: string;
    content?: string;
  };
}

export interface GrokChatCompletionResponse {
  choices: GrokChatCompletionChoice[];
  [key: string]: unknown;
}

let cachedHeaders: HeadersInit | null = null;

function getApiKey(): string {
  const apiKey = process.env.GROK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing Grok API credentials (set GROK_API_KEY or OPENAI_API_KEY)');
  }
  return apiKey;
}

function getHeaders(): HeadersInit {
  if (cachedHeaders) {
    return cachedHeaders;
  }

  const apiKey = getApiKey();
  cachedHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  return cachedHeaders;
}

export async function runChatCompletion(
  request: GrokChatCompletionRequest,
  init: { signal?: AbortSignal } = {}
): Promise<GrokChatCompletionResponse> {
  const headers = getHeaders();
  const response = await fetch(GROK_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: init.signal,
  });

  if (!response.ok) {
    let message = `Grok API request failed with status ${response.status}`;
    const bodyText = await response.text();
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const errorMessage = data?.error?.message || data?.error || data?.message;
        if (errorMessage) {
          message += `: ${errorMessage}`;
        }
      } catch (err) {
        message += `: ${bodyText}`;
      }
    }
    const error = new Error(message);
    (error as { status?: number }).status = response.status;
    throw error;
  }

  return (await response.json()) as GrokChatCompletionResponse;
}

export const DEFAULT_GROK_MODEL =
  process.env.GROK_VERIFICATION_MODEL?.trim() || 'grok-4';
