import { SUBSCRIBE_TEMPLATES, type SubscribeType } from '../config/subscribe';

/**
 * 请求订阅消息授权。
 *
 * 在用户主动操作（点「立即预约」「取消预约」「开启通知」）的回调里调用，弹出微信官方授权卡片。
 * 用户拒绝 / 基础库不支持 / 未配置模板：绝不抛错、绝不阻断业务流程。
 *
 * ⚠️ 排障必备：早期版本把一切异常都静默吞掉，真机上「不弹窗」时完全无从判断原因。
 * 现在返回结构化结果（是否弹窗 / errCode / 各模板的允许与拒绝），
 * 并统一打进 console（真机调试的 vConsole 能直接看到）。
 *
 * ⚠️ 血泪坑之一：**批量请求是全有或全无**
 * wx.requestSubscribeMessage 一次可带多个 tmplId，但**只要其中任意一张模板 ID 无效
 * （未选用 / 已过期 / 不属于本账号 / 已封禁），整批调用会被微信直接拒绝，
 * 结果是一张卡都弹不出来**，且错误信息只落在 fail 回调里，极易被忽略。
 *
 * ⛔ 这里**故意不做**「批量失败 → 自动改请求主模板」的兜底（2026-09-17 删除）：
 * 走到 fail 分支时已经 `await` 过，点击手势早没了，重试**必定**报
 * `can only be invoked by user TAP gesture`，还会把真实失败原因覆盖掉。
 * 正确姿势：如实上报失败原因，把重试交回用户的**下一次点击**（重新点「开启」即可）。
 *
 * ⚠️ 血泪坑之二：**「总是保持以上选择」会永久关掉弹卡**
 * 微信授权卡底部那个复选框**默认就是勾选的**。用户若在勾着它的状态下点「拒绝」，
 * 微信会把该模板**永久**记为拒绝（errCode 20002）→ 之后调用连卡都不弹，直接 reject。
 * 该状态无 API 可重置，只能让用户去「小程序 → … → 设置 → 订阅消息」手动打开，
 * 或者在公众平台换一张新模板（新 tmplId 对用户而言是"从未选过"）。
 */

export type SubscribeDecision = 'accept' | 'reject' | 'ban' | 'unknown';

export interface SubscribeOutcome {
  /** 是否成功唤起授权弹窗。false = 压根没弹（模板未配 / 接口不可用 / 调用失败） */
  shown: boolean;
  /** 微信返回的原始 errCode（失败时） */
  errCode?: number;
  /** 微信返回的原始 errMsg */
  errMsg?: string;
  /** 用户点了「允许」的模板槽位 */
  accepted: SubscribeType[];
  /** 用户点了「拒绝」/ 模板被封禁的槽位 */
  rejected: SubscribeType[];
  /** 需要用户或开发者手动处理时的中文提示；无需处理时为空串 */
  hint: string;
}

/**
 * 微信 errCode → 可执行的中文提示。
 * 参考 wx.requestSubscribeMessage 的 fail 回调错误码。
 */
function hintForError(errCode?: number, errMsg?: string): string {
  // 「手势丢失」：微信只给 errMsg、不给 errCode，必须靠文案识别。
  // 这不是用户的问题，而是调用时机不对（在 await 之后才调），
  // 必须给出可执行的开发者提示，否则真机上只会看到一句英文报错。
  if (errMsg && /TAP gesture/i.test(errMsg)) {
    return (
      '订阅授权调用时机不对：微信要求该接口必须由「用户点击手势」同步唤起，' +
      '而当前调用已经脱离了手势（常见原因：先 await 了 showModal 等异步 API）。' +
      '请把订阅调用挪到点击回调的第一句（详见 pages/profile 的 onConfirmEnableNotify 注释）。'
    );
  }
  switch (errCode) {
    case 10004:
    case 10005:
    case 10006:
    case 10007:
      return '订阅消息模板无效或不存在：请到微信公众平台「订阅消息 → 我的模板」重新选用，并把模板 ID 同步到 miniprogram/config/subscribe.ts 与 notify 云函数。';
    case 10001:
    case 10003:
      return '订阅授权参数有误（模板 ID 格式不对），请检查 config/subscribe.ts。';
    case 20002:
      return '你刚刚拒绝了订阅授权，可点「开启预约通知」重试。若你此前勾选过「总是保持以上选择」（即永久拒绝），微信不会再弹授权卡，需到设置页手动打开订阅开关。';
    case 20003:
      return '尚未授权过订阅消息，请点「开启预约通知」重新授权。';
    case 20004:
      return '你关闭了「接收订阅消息」总开关：请点小程序右上角「…」→ 设置 → 打开「接收订阅消息」，再回来重试（也可在弹窗里点「去设置」）。';
    case 20005:
      return '订阅授权请求过于频繁，请稍后再试。';
    default:
      return errMsg ? `订阅授权失败：${errMsg}` : '';
  }
}

/** 空结果（未弹窗、无错误） */
function emptyOutcome(hint = ''): SubscribeOutcome {
  return { shown: false, accepted: [], rejected: [], hint };
}

interface Pair {
  type: SubscribeType;
  id: string;
}

/** 单次调用微信接口的归一化结果 */
type InvokeResult =
  | { ok: true; decisions: Record<string, unknown> }
  | { ok: false; errCode?: number; errMsg?: string; hint: string };

async function invokeRequest(tmplIds: string[]): Promise<InvokeResult> {
  try {
    const res = await wx.requestSubscribeMessage({ tmplIds });
    return { ok: true, decisions: res as unknown as Record<string, unknown> };
  } catch (err) {
    const e = err as unknown as { errCode?: number; errMsg?: string; message?: string };
    const rawCode = Number(e && e.errCode);
    const errCode = Number.isFinite(rawCode) ? rawCode : undefined;
    const errMsg = String((e && (e.errMsg || e.message)) || '');
    return { ok: false, errCode, errMsg, hint: hintForError(errCode, errMsg) };
  }
}

/** 把微信返回的逐模板决策映射回槽位名 */
function summarize(decisions: Record<string, unknown>, pairs: Pair[]): SubscribeOutcome {
  const accepted: SubscribeType[] = [];
  const rejected: SubscribeType[] = [];
  const banned: string[] = [];

  // 微信把每个模板的决策放在以 tmplId 为键的字段上（accept / reject / ban）
  pairs.forEach(({ type, id }) => {
    const decision = String(decisions[id] || 'unknown');
    if (decision === 'accept') accepted.push(type);
    else {
      rejected.push(type);
      if (decision === 'ban') banned.push(type);
    }
  });

  const shown = accepted.length > 0 || rejected.length > 0;
  // ⚠️ 这里只报「发生了什么」，不写「所以你应该怎样」——
  // 长文案会淹没真正的原因；可执行建议由调用方按 errCode 一句话给出。
  let hint = '';
  if (banned.length) {
    hint = `模板「${banned.join('、')}」已被微信封禁，需要到公众平台更换模板。`;
  } else if (!accepted.length) {
    hint = '这次没有拿到授权，暂时收不到预约通知。';
  }

  console.log('[订阅授权] 成功', { accepted, rejected, raw: decisions });
  return { shown, accepted, rejected, hint };
}

export async function requestSubscribe(types: SubscribeType[]): Promise<SubscribeOutcome> {
  if (!wx.requestSubscribeMessage) {
    const hint = '当前微信版本不支持订阅消息（需基础库 2.4.4+），请升级微信。';
    console.warn('[订阅授权] 接口不可用', hint);
    return emptyOutcome(hint);
  }

  // 槽位 → 模板 ID 映射（保留反向表，便于把微信返回的决策映射回槽位名）
  const pairs: Pair[] = types
    .map((t) => ({ type: t, id: SUBSCRIBE_TEMPLATES[t] as string }))
    .filter((p) => typeof p.id === 'string' && p.id.length > 0);

  if (!pairs.length) {
    const hint = '尚未配置任何订阅消息模板 ID，因此不会弹窗。请先在 config/subscribe.ts 填入 mp 后台选用到的模板 ID。';
    console.warn('[订阅授权] 无可用模板', hint);
    return emptyOutcome(hint);
  }

  // 微信单次上限 3 张；超出会被拒，这里主动截断保护
  const batch = pairs.slice(0, 3);
  console.log('[订阅授权] 发起请求', { tmplIds: batch.map((p) => p.id), types: batch.map((p) => p.type) });

  const first = await invokeRequest(batch.map((p) => p.id));
  if (first.ok) return summarize(first.decisions, batch);

  console.warn('[订阅授权] 请求失败', { errCode: first.errCode, errMsg: first.errMsg, hint: first.hint });

  // ⚠️ 这里**不做**「批量失败 → 自动只重试第一张」的降级（2026-09-17 移除）。
  //
  // 历史实现确实这么写过，但它**从来不可能成功**，而且有害：
  // 微信要求 requestSubscribeMessage 必须由用户点击手势**同步**唤起，
  // 而代码走到这里已经过了 `await invokeRequest(...)`，点击手势早已用掉 →
  // 第二次调用必定返回 `fail can only be invoked by user TAP gesture`。
  // 更糟的是：这条「调用时机不对」是**开发者层面的提示**，它会覆盖掉真正的
  // 失败原因（模板 ID 无效 / 用户永久拒绝 / 总开关关闭），
  // 于是用户在真机上只看到一句莫名其妙的英文报错，完全查不出问题 ——
  // 这正是「点开启没反应、也不知道为什么」的根源之一。
  //
  // 正确做法：如实上报失败原因（errCode + hint）；用户想重试就**再点一次**入口按钮。
  return {
    shown: false,
    errCode: first.errCode,
    errMsg: first.errMsg,
    accepted: [],
    rejected: [],
    hint: first.hint,
  };
}

/**
 * 把授权结果转成给用户看的一句话（用于「开启通知」等显式入口）。
 * 业务主流程请勿直接弹窗，避免打断下单。
 */
export function describeOutcome(outcome: SubscribeOutcome): string {
  if (outcome.accepted.length) {
    return `已开启 ${outcome.accepted.length} 项预约通知，感谢配合！`;
  }
  if (outcome.hint) return outcome.hint;
  return '未获取到订阅授权，暂时收不到预约通知。';
}
