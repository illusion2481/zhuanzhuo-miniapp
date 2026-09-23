/**
 * AI API 统一封装 — Phase 6 完整实现
 * Key 仅从环境变量读取，禁止硬编码
 */

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiClientOptions {
  timeoutMs?: number;
  retries?: number;
}

export async function chatCompletion(
  messages: AiChatMessage[],
  options: AiClientOptions = {},
): Promise<string> {
  const apiKey = process.env.CODING_PLAN_API_KEY;
  const baseUrl = process.env.CODING_PLAN_BASE_URL || 'https://chatapi.weixin.qq.com/openai/v1';
  const model = process.env.CODING_PLAN_MODEL || 'Deepseek-v4-flash';
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!apiKey) {
    throw new Error('CODING_PLAN_API_KEY 未配置');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`AI 请求失败: HTTP ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}
