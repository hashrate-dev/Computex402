/**
 * Minimal OpenAI-compatible chat client. Defaults to OpenRouter; any
 * /chat/completions endpoint with tool calling works (set LLM_BASE_URL).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.OPENROUTER_API_KEY ?? env.LLM_API_KEY;
  if (!apiKey) throw new Error("set OPENROUTER_API_KEY (or LLM_API_KEY)");
  return {
    baseUrl: (env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    apiKey,
    model: env.LLM_MODEL ?? "openai/gpt-4o-mini",
  };
}

export async function chat(cfg: LlmConfig, messages: ChatMessage[], tools?: unknown[]) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
      // OpenRouter attribution headers (optional, harmless elsewhere).
      "HTTP-Referer": "https://github.com/hashrate-dev/Computex402",
      "X-Title": "ComputePass 402 agent",
    },
    body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: tools ? "auto" : undefined, temperature: 0 }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`LLM ${res.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  const choice = body.choices?.[0];
  if (!choice) throw new Error("LLM returned no choices");
  return { message: choice.message as ChatMessage, usage: body.usage, model: body.model as string };
}
