#!/usr/bin/env node
/**
 * AI Key 自检脚本 —— 上云配置前，先在本地确认「Key 通不通、该用哪个模型名」。
 *
 * 用法（三选一，脚本不会把 Key 写入任何文件）：
 *   1) 环境变量：  $env:CODING_PLAN_API_KEY="你的Key"; node scripts/check-ai-key.cjs
 *   2) 交互输入：  node scripts/check-ai-key.cjs        （回车后粘贴，推荐，不进命令行历史）
 *   3) 命令行参数：node scripts/check-ai-key.cjs <你的Key>  （会留在 shell history，不推荐）
 *
 * 可选参数：
 *   --base-url <url>   覆盖网关地址（默认 https://chatapi.weixin.qq.com/openai/v1）
 *   --model <name>     只测指定模型，跳过候选列表遍历
 *   --timeout <ms>     单次请求超时（默认 20000）
 *
 * 退出码：0 = 至少有一个可用模型；1 = Key 不可用或全部模型失败；2 = 缺少 Key / 无 fetch
 *
 * 安全约定：Key 只存在于本进程内存，输出中一律脱敏（前 4 位 + **** + 后 2 位）。
 */

const readline = require('readline');

const DEFAULT_BASE_URL = 'https://chatapi.weixin.qq.com/openai/v1';

/**
 * 模型名候选：网关对大小写敏感且文档写法不一致，
 * 逐个试探后告诉用户「到底哪个能用」，避免配完才发现 400。
 */
const CANDIDATE_MODELS = [
  'Deepseek-v4-flash',
  'DeepSeek-V4-Flash',
  'deepseek-v4-flash',
  'GLM-5.2',
  'glm-5.2',
  'glm-5',
  'DeepSeek-V4',
];

function mask(key) {
  const k = String(key || '');
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}****${k.slice(-2)}`;
}

function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE_URL, model: '', timeout: 20000, positional: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-url') { out.baseUrl = argv[i + 1] || out.baseUrl; i += 1; }
    else if (a === '--model') { out.model = argv[i + 1] || ''; i += 1; }
    else if (a === '--timeout') { out.timeout = Number(argv[i + 1]) || out.timeout; i += 1; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (!a.startsWith('--') && !out.positional) { out.positional = a; }
  }
  return out;
}

function printHelp() {
  console.log([
    '',
    'AI Key 自检 —— 确认 Coding Plan Token 是否可用、哪个模型名能用',
    '',
    '  node scripts/check-ai-key.cjs                 交互输入（推荐，不进命令行历史）',
    '  $env:CODING_PLAN_API_KEY="xxx"; node scripts/check-ai-key.cjs',
    '  node scripts/check-ai-key.cjs --model GLM-5.2 只测指定模型',
    '',
    '提示：Key 不会被保存到任何文件，输出中只显示脱敏结果。',
    '',
  ].join('\n'));
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

/** 发起一次最小 chat 请求，返回 { ok, status, model, message, body } */
async function probe(baseUrl, apiKey, model, timeoutMs) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON，保留原文 */ }
    const reply = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content
      : '';
    if (res.ok) {
      return { ok: true, status: res.status, model, message: reply || '（无返回内容）' };
    }
    const errMsg = (parsed && parsed.error && (parsed.error.message || parsed.error.code))
      || text.slice(0, 200)
      || `HTTP ${res.status}`;
    return { ok: false, status: res.status, model, message: String(errMsg) };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : ((e && e.message) || String(e));
    return { ok: false, status: 0, model, message: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function explain(status) {
  if (status === 401 || status === 403) return 'Key 无效 / 过期 / 无权限 → 去后台重新领取或重置';
  if (status === 429) return '触发限次（5h 1200 次 / 周 9000 / 月 18000）→ 等窗口刷新';
  if (status === 400) return '模型名不被接受 → 换一个候选模型';
  if (status === 404) return '接口地址不对 → 检查 --base-url';
  if (status === 0) return '网络不通 / 超时 → 检查网络与网关地址';
  return `HTTP ${status}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  if (typeof fetch === 'undefined') {
    console.error('当前 Node 版本没有全局 fetch，请升级到 Node 18+ 后重试。');
    process.exit(2);
  }

  let apiKey = args.positional || process.env.CODING_PLAN_API_KEY || '';
  if (!apiKey) {
    apiKey = await ask('粘贴你的 Coding Plan Token（输入不会保存到任何文件）：');
  }
  if (!apiKey) {
    console.error('未获取到 Key。可用环境变量 CODING_PLAN_API_KEY 传入，或交互输入。');
    process.exit(2);
  }

  const models = args.model ? [args.model] : CANDIDATE_MODELS;
  console.log('');
  console.log(`网关：${args.baseUrl}`);
  console.log(`Key  ：${mask(apiKey)}`);
  console.log(`模型 ：候选 ${models.length} 个，逐个试探…`);
  console.log('');

  const results = [];
  let authFailed = false;
  let rateLimited = false;

  for (const m of models) {
    const r = await probe(args.baseUrl, apiKey, m, args.timeout);
    results.push(r);
    const flag = r.ok ? '✅' : '❌';
    console.log(`${flag} ${m.padEnd(20)} ${r.ok ? `HTTP ${r.status}  ${String(r.message).slice(0, 60)}` : `HTTP ${r.status || '-'}  ${String(r.message).slice(0, 120)}`}`);
    // 鉴权失败 / 限次 / 网络不通：这些是全量问题，再试其它模型没有意义，直接收尾
    if (r.status === 401 || r.status === 403) { authFailed = true; break; }
    if (r.status === 429) { rateLimited = true; break; }
    if (r.status === 0) { break; }
  }

  const usable = results.filter((r) => r.ok);

  console.log('');
  if (authFailed) {
    console.log(`结论：鉴权失败 —— ${explain(results[results.length - 1].status)}`);
    console.log('Key 本身用不了，不必再试其它模型。');
    process.exit(1);
  }
  if (rateLimited) {
    console.log('结论：触发限次。Key 是有效的，等额度窗口刷新后再试。');
    process.exit(1);
  }
  if (usable.length === 0) {
    console.log('结论：没有可用模型。');
    const last = results[results.length - 1];
    console.log(`最后错误：${explain(last.status)}`);
    console.log('若全是 400，说明该 Key 绑定的套餐不支持这些模型，去后台确认可用模型列表。');
    process.exit(1);
  }

  const first = usable[0];
  console.log(`结论：Key 可用 ✅  推荐 CODING_PLAN_MODEL = ${first.model}`);
  if (usable.length > 1) {
    console.log(`其它可用模型：${usable.slice(1).map((r) => r.model).join('、')}`);
  }
  console.log('');
  console.log('下一步：云开发控制台 → 云函数 → aiRecommend / aiSummary / aiChat → 配置 → 环境变量');
  console.log('  CODING_PLAN_API_KEY  = 你的 Token（凭据就是这一个；三个函数都要各自配一遍）');
  console.log(`  CODING_PLAN_MODEL    = ${first.model}`);
  console.log('  CODING_PLAN_BASE_URL = 留空（用默认网关，它只是接口地址、不是 Token）');
  console.log('然后「上传并部署：所有文件」（必须带 shared/ 目录）。');
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('自检脚本异常：', (e && e.message) || e);
  process.exit(2);
});
