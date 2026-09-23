/**
 * AI API 统一封装（CommonJS，cloudfunctions 运行时）
 * Key 仅从环境变量读取，禁止硬编码
 *
 * 通道：微信 Coding Plan（chatapi.weixin.qq.com，OpenAI 兼容协议）。
 * 微信小程序开发大赛 / AI 小程序成长计划发放的 Token 即为本通道凭证，
 * 配到云函数环境变量 CODING_PLAN_API_KEY 即可，无需改代码。
 *
 * ⚠️ 该通道是「限次不限量」（约 5h/1200 次、周 9000 次、月 18000 次），
 * 因此本封装内置 10 分钟结果缓存：同一份 prompt 复用上次结果，
 * 避免用户反复刷新、多人同时进页面把调用次数烧完 → 全站静默降级成基础版。
 *
 * ⚠️ 不能假设运行时有全局 fetch：fetch 是 Node 18 才引入的全局 API，
 * 而微信云函数常见运行时仍为 Node 16，且本项目所有云函数都未安装 node-fetch。
 * 一旦运行时没有 fetch，云端会抛 AI_NO_FETCH，用户看到「AI 客服正在配置中」——
 * 与「Key 没配」撞成同一句话，完全无法区分（2026-09-22 踩过）。
 * 所以这里用 Node 内置 http/https 实现了最小 fetch 兜底，任何 Node 版本都能发请求。
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DEFAULT_BASE_URL = 'https://chatapi.weixin.qq.com/openai/v1';
const DEFAULT_MODEL = 'Deepseek-v4-flash';
/**
 * 网关对模型名大小写敏感，而不同文档里写法不一致（Deepseek / DeepSeek）。
 * 首个被拒绝时按顺序回退，避免「只差一个字母大小写」就让整个 AI 功能降级。
 */
const MODEL_FALLBACKS = ['Deepseek-v4-flash', 'DeepSeek-V4-Flash', 'GLM-5.2'];
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_INPUT_CHARS = 2000;

/** 结果缓存：限次通道下最重要的保护（云函数冷启动后失效，仍能挡掉大部分重复请求） */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map();

/**
 * 用 Node 内置 http/https 实现的最小 fetch，只覆盖本项目用到的能力：
 * POST + JSON body + 自定义 header + 超时（AbortSignal 或 options.timeoutMs）。
 * 返回与 fetch Response 同形的对象：{ ok, status, text(), json() }。
 */
function createNodeFetch() {
  return function nodeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(String(url)); // global URL：Node 10+ 均有
      } catch (e) {
        reject(new Error(`请求地址不合法: ${url}`));
        return;
      }

      const payload = options.body == null ? null : String(options.body);
      const headers = Object.assign({}, options.headers || {});
      if (payload && headers['Content-Length'] == null) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const isHttp = target.protocol === 'http:';
      const mod = isHttp ? http : https;
      const req = mod.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttp ? 80 : 443),
          path: `${target.pathname}${target.search || ''}`,
          method: options.method || 'GET',
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        },
      );

      req.on('error', reject);

      const timeoutMs = options.timeoutMs || 0;
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（>${timeoutMs}ms）`)));
      }

      const signal = options.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('请求已被取消'));
        } else if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => req.destroy(new Error('请求已被取消')));
        }
      }

      if (payload) req.write(payload);
      req.end();
    });
  };
}

/**
 * 依次尝试：全局 fetch（Node 18+）→ node-fetch（若已安装）→ 内置 http/https 实现。
 * 第三条兜底保证任何 Node 版本都能发请求，因此不再存在「运行时不支持」这条死路。
 */
function resolveFetch() {
  if (typeof fetch === 'function') return fetch;
  try {
    const mod = require('node-fetch');
    const impl = mod && (mod.default || mod);
    if (typeof impl === 'function') return impl;
  } catch (e) {
    // 未安装 node-fetch 不是错误，继续走内置实现
  }
  return createNodeFetch();
}

/** 环境变量指定的模型优先，随后补上回退候选（去重） */
function buildModelList(envModel) {
  const list = [];
  const push = (m) => {
    if (m && list.indexOf(m) < 0) list.push(m);
  };
  push(envModel);
  for (const m of MODEL_FALLBACKS) push(m);
  return list;
}

function cacheKeyOf(baseUrl, models, messages) {
  const raw = `${baseUrl}|${models.join(',')}|${JSON.stringify(messages)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/** 把 HTTP 状态码翻译成「下一步该查什么」，避免日志里只剩一个 HTTP 429 无从下手 */
function hintForStatus(status) {
  if (status === 401 || status === 403) return '（Key 无效/过期，检查环境变量 CODING_PLAN_API_KEY）';
  if (status === 429) return '（触发频率限制：Coding Plan 限次不限量，请减少调用频次）';
  if (status === 400) return '（请求被拒：多为模型名不匹配，可设 CODING_PLAN_MODEL=GLM-5.2）';
  if (status === 404) return '（接口地址不对：CODING_PLAN_BASE_URL 应为 https://chatapi.weixin.qq.com/openai/v1，或直接留空用默认值）';
  if (status >= 500) return '（上游服务异常，可稍后重试）';
  return '';
}

/**
 * 配置类故障最贵的成本是「不知道到底缺了什么」。
 * 这里只回传环境变量的**名字**（绝不回传值，避免泄露），用于区分三种常见原因：
 * ① 名字拼错（多空格 / 大小写不符）② 配到了别的函数 ③ 真的没配。
 */
function describeEnvHints() {
  let names = [];
  try {
    names = Object.keys(process.env)
      .filter((k) => /CODING|PLAN|API_KEY|APIKEY|TOKEN/i.test(k))
      .sort();
  } catch (e) {
    return '';
  }
  if (!names.length) {
    return '（当前环境变量中没有任何 CODING / PLAN / API_KEY / TOKEN 相关项 → 基本可判定是「没配到本函数」）';
  }
  return `（本函数可见的相关环境变量名：${names.join(', ')} → 若其中没有 CODING_PLAN_API_KEY，就是名字拼写不符）`;
}

async function requestOnce(fetchImpl, baseUrl, apiKey, model, messages, timeoutMs) {
  // AbortController 在 Node 15 才内置；低版本运行时靠 options.timeoutMs 交给兜底实现超时
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: controller ? controller.signal : undefined,
      timeoutMs,
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = String((await res.text()) || '').slice(0, 200);
      } catch (e) {
        // 读取响应体失败不影响主错误
      }
      const err = new Error(
        `AI 请求失败: HTTP ${res.status} ${hintForStatus(res.status)}${detail ? ` | ${detail}` : ''}`,
      );
      err.code = `AI_HTTP_${res.status}`;
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return content ? String(content) : '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{role: 'system'|'user'|'assistant', content: string}[]} messages
 * @param {{timeoutMs?: number, retries?: number}} [options]
 * @returns {Promise<string>}
 */
async function chatCompletion(messages, options = {}) {
  const apiKey = process.env.CODING_PLAN_API_KEY;
  const baseUrl = process.env.CODING_PLAN_BASE_URL || DEFAULT_BASE_URL;
  const models = buildModelList(process.env.CODING_PLAN_MODEL || DEFAULT_MODEL);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) {
    const err = new Error(`CODING_PLAN_API_KEY 未配置${describeEnvHints()}`);
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages 不能为空');
  }

  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    const err = new Error(`当前 Node 运行时无法发起 HTTPS 请求（node ${process.version}）`);
    err.code = 'AI_NO_FETCH';
    throw err;
  }

  // 输入总长度限制（Plan §4.4: 单次输入不超过 2000 字）
  const totalLen = messages.reduce((acc, m) => acc + (m && m.content ? String(m.content).length : 0), 0);
  if (totalLen > MAX_INPUT_CHARS) {
    const err = new Error(`输入内容超过 ${MAX_INPUT_CHARS} 字`);
    err.code = 'AI_INPUT_TOO_LONG';
    throw err;
  }

  // 限次保护：prompt 完全一致时直接复用上次结果
  const key = cacheKeyOf(baseUrl, models, messages);
  const cached = readCache(key);
  if (cached !== undefined) return cached;

  let lastErr;
  for (let i = 0; i < models.length; i += 1) {
    try {
      const content = await requestOnce(fetchImpl, baseUrl, apiKey, models[i], messages, timeoutMs);
      writeCache(key, content);
      return content;
    } catch (err) {
      lastErr = err;
      // 仅「模型名不被接受」才换下一个候选；鉴权/限流/超时换了也没用，直接抛
      if (!(err && err.status === 400) || i === models.length - 1) throw err;
    }
  }
  throw lastErr;
}

/**
 * 尝试以递增间隔重试 1 次（用于瞬时网络抖动），仍失败则抛出
 */
async function chatCompletionWithRetry(messages, options = {}) {
  const retries = options.retries != null ? options.retries : 1;
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await chatCompletion(messages, { timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    } catch (err) {
      lastErr = err;
      // 配置错误、过长输入不重试；鉴权失败与限流重试只会更糟
      const noRetry =
        err &&
        (err.code === 'AI_NOT_CONFIGURED' ||
          err.code === 'AI_INPUT_TOO_LONG' ||
          err.code === 'AI_NO_FETCH' ||
          err.code === 'AI_HTTP_401' ||
          err.code === 'AI_HTTP_403' ||
          err.code === 'AI_HTTP_429');
      if (noRetry) throw err;
      attempt += 1;
      if (attempt > retries) break;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

module.exports = {
  chatCompletion,
  chatCompletionWithRetry,
  DEFAULT_TIMEOUT_MS,
  MAX_INPUT_CHARS,
};
