// ─────────────────────────────────────────────────────────────────────────────
// Shared vendor-agnostic LLM call.
//
// Extracted verbatim from digest-generator.js so more than one caller (the
// digest generator AND the pro moderation judge) can issue a single-shot model
// call without each re-implementing vendor routing, the OpenAI reasoning_effort
// / max_completion_tokens fallbacks, and 429 retry.
//
// The ONLY behavioural change vs the inlined version is that model + vendor are
// now parameters (defaulting to config.claudeModel / config.llmVendor). Passing
// neither reproduces the original behaviour byte-for-byte, which is exactly how
// digest-generator.js calls it — so existing digest behaviour is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';

const RETRY_ATTEMPTS = 3;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single model call (already vendor-specific) with exponential-backoff
 * retry on 429. `fn` returns the raw vendor response.
 */
export async function withRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 429 && attempt < RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[llm] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

/**
 * Vendor-agnostic single-shot model call. Routes to Anthropic (default) or
 * OpenAI. Returns text plus token usage.
 *
 * @param {Object} config App config (llmVendor, claudeModel, *BaseUrl, *ApiKey)
 * @param {{system:string, user:string, maxTokens:number, model?:string, vendor?:string}} opts
 *        model  — defaults to config.claudeModel
 *        vendor — defaults to config.llmVendor
 * @returns {Promise<{text:string, inputTokens:number, outputTokens:number}>}
 */
export async function callModel(config, { system, user, maxTokens, model, vendor }) {
  const resolvedVendor = vendor || config.llmVendor || 'anthropic';
  const resolvedModel = model || config.claudeModel;

  if (resolvedVendor === 'openai') {
    const openaiBaseUrl = String(config.openaiBaseUrl || '').trim();
    const isLocalOpenAiCompatible = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(openaiBaseUrl);

    if (!config.openaiApiKey && !isLocalOpenAiCompatible) {
      throw new Error('OpenAI API key не настроен (.env: OPENAI_API_KEY)');
    }

    // OpenAI SDK requires a non-empty apiKey even when talking to a local
    // OpenAI-compatible server such as Ollama, which itself does not require
    // authentication. Use a harmless local-only placeholder in that case.
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: config.openaiApiKey || 'ollama-local',
      baseURL: openaiBaseUrl || undefined,
    });
    const request = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (config.openaiReasoningEffort) {
      request.reasoning_effort = config.openaiReasoningEffort;
    }
    let resp;
    try {
      resp = await withRetry(() => client.chat.completions.create({
        ...request,
        max_completion_tokens: maxTokens,
      }));
    } catch (err) {
      const message = String(err.message || '');
      if (request.reasoning_effort && message.includes('reasoning_effort')) {
        delete request.reasoning_effort;
        resp = await withRetry(() => client.chat.completions.create({
          ...request,
          max_completion_tokens: maxTokens,
        }));
      } else if (!message.includes('max_completion_tokens')) {
        throw err;
      } else {
        resp = await withRetry(() => client.chat.completions.create({
          ...request,
          max_tokens: maxTokens,
        }));
      }
    }
    return {
      text: resp.choices[0]?.message?.content || '',
      inputTokens: resp.usage?.prompt_tokens || 0,
      outputTokens: resp.usage?.completion_tokens || 0,
    };
  }

  // Default: Anthropic
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl || undefined,
  });
  const resp = await withRetry(() => client.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }));
  return {
    text: resp.content[0]?.text || '',
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
  };
}
