const GROK_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

export type GrokChatCompletionMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

interface GrokChatCompletionRequest {
  model: string;
  messages: GrokChatCompletionMessage[];
  temperature?: number;
  stream?: boolean;
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
  const apiKey = process.env.GROK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing Grok API credentials (set GROK_API_KEY)');
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

  if (request.stream) {
    if (!response.body) {
      throw new Error('Grok API response did not include a readable body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let role: string | undefined;
    let aggregatedContent = '';

    const processEvent = (event: string) => {
      const lines = event.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const dataPayload = line.slice(5).trim();
        if (!dataPayload || dataPayload === '[DONE]') {
          continue;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataPayload);
        } catch (err) {
          throw new Error('Failed to parse Grok streaming payload');
        }

        const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
        for (const choice of choices) {
          const delta = choice?.delta ?? {};
          if (typeof delta.role === 'string') {
            role = delta.role;
          }
          if (typeof delta.content === 'string') {
            aggregatedContent += delta.content;
          }
        }
      }
    };

    const flushBuffer = () => {
      const trimmed = buffer.trim();
      if (trimmed) {
        processEvent(trimmed);
      }
      buffer = '';
    };

    const findEventBoundary = (text: string): { index: number; length: number } | null => {
      const doubleNewlineIndex = text.indexOf('\n\n');
      const carriageReturnIndex = text.indexOf('\r\n\r\n');

      if (doubleNewlineIndex === -1 && carriageReturnIndex === -1) {
        return null;
      }

      if (doubleNewlineIndex === -1) {
        return { index: carriageReturnIndex, length: 4 };
      }

      if (carriageReturnIndex === -1) {
        return { index: doubleNewlineIndex, length: 2 };
      }

      return doubleNewlineIndex < carriageReturnIndex
        ? { index: doubleNewlineIndex, length: 2 }
        : { index: carriageReturnIndex, length: 4 };
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = findEventBoundary(buffer);
      while (boundary) {
        const event = buffer.slice(0, boundary.index);
        processEvent(event);
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = findEventBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      flushBuffer();
    }

    return {
      choices: [
        {
          message: {
            role: role || 'assistant',
            content: aggregatedContent,
          },
        },
      ],
    } satisfies GrokChatCompletionResponse;
  }

  return (await response.json()) as GrokChatCompletionResponse;
}

export const DEFAULT_GROK_MODEL =
  process.env.GROK_VERIFICATION_MODEL?.trim() || 'grok-4';
