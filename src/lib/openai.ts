import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY environment variable');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type ChatCompletionClient = {
  chat: {
    completions: {
      create: (
        params: ChatCompletionCreateParamsNonStreaming
      ) => Promise<ChatCompletion>;
    };
  };
};

const FIXED_TEMPERATURE_PREFIXES = [/^gpt-4\.1/i, /^gpt-5/i, /^o\d/i];

function supportsAdjustableTemperature(model: string): boolean {
  return !FIXED_TEMPERATURE_PREFIXES.some((pattern) => pattern.test(model));
}

function requiresMaxCompletionTokens(model: string): boolean {
  return FIXED_TEMPERATURE_PREFIXES.some((pattern) => pattern.test(model));
}

function normalizeChatCompletionParams(
  params: ChatCompletionCreateParamsNonStreaming
): ChatCompletionCreateParamsNonStreaming {
  const sanitized = {
    ...params,
  } as ChatCompletionCreateParamsNonStreaming & {
    max_completion_tokens?: number | null;
  };

  if (
    sanitized.temperature !== undefined &&
    sanitized.temperature !== null &&
    sanitized.temperature !== 1 &&
    !supportsAdjustableTemperature(sanitized.model)
  ) {
    delete sanitized.temperature;
  }

  if (
    sanitized.max_tokens !== undefined &&
    sanitized.max_tokens !== null &&
    requiresMaxCompletionTokens(sanitized.model)
  ) {
    sanitized.max_completion_tokens = sanitized.max_tokens;
    delete sanitized.max_tokens;
  }

  return sanitized;
}

export function createChatCompletion(
  client: ChatCompletionClient,
  params: ChatCompletionCreateParamsNonStreaming
) {
  const normalized = normalizeChatCompletionParams(params);
  return client.chat.completions.create(normalized);
}
