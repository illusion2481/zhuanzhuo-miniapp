/**
 * aiClient 单元测试（不依赖云环境，纯本地 mock fetch）
 *
 * 锁定四条「接上大赛 Token 后才会暴露」的行为：
 *   1. 限次通道必须有结果缓存（否则用户一刷新就把次数烧完）
 *   2. 模型名大小写不被接受时要能自动回退（Deepseek / DeepSeek 写法不一致）
 *   3. 401 / 429 不能重试（重试只会更快耗尽额度，且掩盖配置错误）
 *   4. 未配置 Key 时抛 AI_NOT_CONFIGURED，由调用方降级
 *
 * 运行：node scripts/ai-client.test.cjs
 */

const path = require('path');

const CLIENT = path.join(__dirname, '..', 'cloudfunctions', 'aiRecommend', 'shared', 'aiClient.js');

let pass = 0;
let fail = 0;

function expect(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`);
  }
}

/** 每次都重新加载模块，清空模块级缓存与闭包状态 */
function loadClient() {
  delete require.cache[CLIENT];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(CLIENT);
}

function jsonRes(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** 构造一个按脚本依次响应的 fetch mock，并记录每一次请求 */
function makeFetch(script) {
  const calls = [];
  let i = 0;
  const impl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, model: body.model, auth: opts.headers.Authorization });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (typeof step === 'function') return step(body);
    return step;
  };
  return { impl, calls };
}

const CONTENT = { choices: [{ message: { content: '你好，这是 AI 的回答' } }] };

async function main() {
  console.log('==== ai-client 单元测试 ====');

  // ---------- 1. 未配置 Key ----------
  delete process.env.CODING_PLAN_API_KEY;
  delete process.env.CODING_PLAN_MODEL;
  delete process.env.CODING_PLAN_BASE_URL;

  {
    const { chatCompletion } = loadClient();
    let err = null;
    try {
      await chatCompletion([{ role: 'user', content: 'hi' }]);
    } catch (e) {
      err = e;
    }
    expect('未配置 Key 抛 AI_NOT_CONFIGURED', err && err.code === 'AI_NOT_CONFIGURED', err && err.message);
  }

  // ---------- 2. 入参校验 ----------
  process.env.CODING_PLAN_API_KEY = 'test-key';
  {
    const { chatCompletion } = loadClient();
    let e1 = null;
    let e2 = null;
    try {
      await chatCompletion([]);
    } catch (e) {
      e1 = e;
    }
    try {
      await chatCompletion([{ role: 'user', content: 'x'.repeat(2001) }]);
    } catch (e) {
      e2 = e;
    }
    expect('空 messages 被拒', !!e1, String(e1));
    expect('超长输入抛 AI_INPUT_TOO_LONG', e2 && e2.code === 'AI_INPUT_TOO_LONG', e2 && e2.message);
  }

  // ---------- 3. 成功路径 + 缓存 ----------
  {
    const { chatCompletion } = loadClient();
    const f = makeFetch([jsonRes(CONTENT)]);
    global.fetch = f.impl;
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: '帮我总结' }];

    const first = await chatCompletion(msgs);
    expect('成功返回内容', first === '你好，这是 AI 的回答', first);
    expect('首次调用发起 1 次请求', f.calls.length === 1, String(f.calls.length));

    const second = await chatCompletion(msgs);
    expect('相同输入命中缓存（不再请求）', f.calls.length === 1, String(f.calls.length));
    expect('缓存返回同内容', second === first, second);

    await chatCompletion([{ role: 'system', content: 'sys' }, { role: 'user', content: '换个问题' }]);
    expect('不同输入重新请求', f.calls.length === 2, String(f.calls.length));
  }

  // ---------- 4. 模型名回退 ----------
  {
    const { chatCompletion } = loadClient();
    const f = makeFetch([
      jsonRes({ error: 'unknown model' }, 400),
      jsonRes(CONTENT),
    ]);
    global.fetch = f.impl;
    const out = await chatCompletion([{ role: 'user', content: '模型回退测试' }]);
    expect('首个模型 400 时自动换下一个', out === '你好，这是 AI 的回答', out);
    expect('确实换了模型名', f.calls.length === 2 && f.calls[0].model !== f.calls[1].model,
      JSON.stringify(f.calls.map((c) => c.model)));
    expect('回退到 GLM-5.2', f.calls[1].model === 'DeepSeek-V4-Flash', f.calls[1].model);
  }

  // ---------- 5. 全部模型都 400 → 失败且耗尽候选 ----------
  {
    const { chatCompletion } = loadClient();
    const f = makeFetch([jsonRes({ error: 'unknown model' }, 400)]);
    global.fetch = f.impl;
    let err = null;
    try {
      await chatCompletion([{ role: 'user', content: '全失败' }]);
    } catch (e) {
      err = e;
    }
    expect('所有候选被拒后抛出 400', err && err.code === 'AI_HTTP_400', err && err.message);
    expect('候选模型全部试过（3 次）', f.calls.length === 3, String(f.calls.length));
  }

  // ---------- 6. 401 不换模型、不重试 ----------
  {
    const { chatCompletionWithRetry } = loadClient();
    const f = makeFetch([jsonRes({ error: 'invalid api key' }, 401)]);
    global.fetch = f.impl;
    let err = null;
    try {
      await chatCompletionWithRetry([{ role: 'user', content: '鉴权失败' }]);
    } catch (e) {
      err = e;
    }
    expect('401 抛 AI_HTTP_401', err && err.code === 'AI_HTTP_401', err && err.message);
    expect('401 不重试只请求 1 次', f.calls.length === 1, String(f.calls.length));
    expect('401 错误信息含排查提示', err && /CODING_PLAN_API_KEY/.test(err.message), err && err.message);
  }

  // ---------- 7. 429 限流不重试 ----------
  {
    const { chatCompletionWithRetry } = loadClient();
    const f = makeFetch([jsonRes({ error: 'rate limited' }, 429)]);
    global.fetch = f.impl;
    let err = null;
    try {
      await chatCompletionWithRetry([{ role: 'user', content: '限流' }]);
    } catch (e) {
      err = e;
    }
    expect('429 抛 AI_HTTP_429', err && err.code === 'AI_HTTP_429', err && err.message);
    expect('429 不重试只请求 1 次', f.calls.length === 1, String(f.calls.length));
    expect('429 错误信息提示限次', err && /频率限制|限次/.test(err.message), err && err.message);
  }

  // ---------- 8. 5xx 网络抖动重试 ----------
  {
    const { chatCompletionWithRetry } = loadClient();
    const f = makeFetch([jsonRes({ error: 'server error' }, 500), jsonRes(CONTENT)]);
    global.fetch = f.impl;
    const out = await chatCompletionWithRetry([{ role: 'user', content: '抖动重试' }]);
    expect('5xx 重试后成功', out === '你好，这是 AI 的回答', out);
    expect('5xx 共请求 2 次（重试 1 次）', f.calls.length === 2, String(f.calls.length));
  }

  // ---------- 9. 环境变量指定的模型优先 ----------
  {
    process.env.CODING_PLAN_MODEL = 'GLM-5.2';
    const { chatCompletion } = loadClient();
    const f = makeFetch([jsonRes(CONTENT)]);
    global.fetch = f.impl;
    await chatCompletion([{ role: 'user', content: '指定模型' }]);
    expect('优先使用 CODING_PLAN_MODEL', f.calls[0].model === 'GLM-5.2', f.calls[0].model);
    delete process.env.CODING_PLAN_MODEL;
  }

  // ---------- 10. Bearer 头正确 ----------
  {
    const { chatCompletion } = loadClient();
    const f = makeFetch([jsonRes(CONTENT)]);
    global.fetch = f.impl;
    await chatCompletion([{ role: 'user', content: '鉴权头' }]);
    expect('Authorization 为 Bearer ${Key}', f.calls[0].auth === 'Bearer test-key', f.calls[0].auth);
    expect('请求地址指向 Coding Plan 网关',
      /chatapi\.weixin\.qq\.com\/openai\/v1\/chat\/completions/.test(f.calls[0].url), f.calls[0].url);
  }

  // ---------- 11. 运行时无全局 fetch → 内置 http/https 兜底仍能发请求 ----------
  // 微信云函数常见运行时是 Node 16（没有全局 fetch），本项目又没装 node-fetch。
  // 不兜底的话云端会抛 AI_NO_FETCH，而它在用户侧与「Key 没配」撞成同一句提示，
  // 只能靠翻日志区分（2026-09-22 实际踩过）。这里起一个本地 HTTP 服务验证兜底通路。
  {
    const http = require('http');
    const Module = require('module');
    const origLoad = Module._load;
    // 屏蔽 node-fetch，强制走内置实现；否则本地装了 node-fetch 就测不到兜底分支
    Module._load = function (request) {
      if (request === 'node-fetch') throw new Error('blocked in test');
      return origLoad.apply(this, arguments);
    };

    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `echo:${body.model}` } }] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const savedFetch = global.fetch;
    const savedBase = process.env.CODING_PLAN_BASE_URL;
    process.env.CODING_PLAN_API_KEY = 'test-key';
    process.env.CODING_PLAN_BASE_URL = `http://127.0.0.1:${port}`;
    global.fetch = undefined;

    try {
      const { chatCompletion } = loadClient();
      const out = await chatCompletion([{ role: 'user', content: '兜底通路测试' }]);
      expect('无全局 fetch 时走内置 http 兜底仍能拿到回答', out === 'echo:Deepseek-v4-flash', out);
    } catch (e) {
      expect('无全局 fetch 时走内置 http 兜底仍能拿到回答', false, String((e && e.message) || e));
    } finally {
      global.fetch = savedFetch;
      Module._load = origLoad;
      if (savedBase === undefined) delete process.env.CODING_PLAN_BASE_URL;
      else process.env.CODING_PLAN_BASE_URL = savedBase;
      server.close();
    }
  }

  console.log(`\n==== ai-client: pass=${pass} fail=${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
