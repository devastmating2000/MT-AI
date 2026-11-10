import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { config } from '../config';

let client: Anthropic | null = null;
let disabledReason: string | null = null;

// Models that accept the server-side refusal fallback parameter.
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function llmAvailable(): boolean {
  return config.llmEnabled && disabledReason === null;
}

export function llmStatus(): { enabled: boolean; model: string } {
  return { enabled: llmAvailable(), model: config.llmModel };
}

/**
 * One structured-output call. Returns null whenever the model cannot be used (no key, refusal,
 * API error); callers must always have a deterministic path for that case.
 */
export async function askStructured<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S> | null> {
  if (!llmAvailable()) return null;
  client ??= new Anthropic();
  try {
    const useFallback = FALLBACK_MODELS.has(config.llmModel);
    const response = await client.beta.messages.parse(
      {
        model: config.llmModel,
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: betaZodOutputFormat(schema), effort: 'low' },
        ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { timeout: 45_000 },
    );
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    return response.parsed_output ?? null;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      disabledReason = 'credenciais inválidas';
      console.error('[llm] credenciais rejeitadas; os agentes passam a usar regras determinísticas');
    } else if (error instanceof Anthropic.RateLimitError) {
      console.warn('[llm] limite de pedidos atingido; decisão tomada sem o modelo');
    } else if (error instanceof Anthropic.APIError) {
      console.warn(`[llm] erro da API ${error.status}: ${error.message}`);
    } else {
      console.warn('[llm] falha:', error);
    }
    return null;
  }
}
