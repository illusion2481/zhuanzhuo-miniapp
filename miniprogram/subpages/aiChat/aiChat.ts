/**
 * AI 客服聊天页（方案 A：无人值守也能回）。
 *
 * 交互：用户发消息 → aiChat 云函数（FAQ 知识库 + Deepseek）回 → 气泡展示；
 *       涉及退款/纠纷等命中人工关键词 → 云端返回 need_human，本页底部出现
 *       「转人工客服」与「提交工单」两个出口按钮。
 *
 * 与微信原生客服会话的关系：这是项目**自带**的聊天页，不依赖你在线；
 *   原生客服（open-type=contact）仍保留在「我的」等页作为最终人工兜底。
 */
import { callCloud } from '../../services/cloud';

interface ChatMsg {
  id: string;
  role: 'user' | 'bot';
  content: string;
  welcome?: boolean;
  /** 云端降级诊断码（仅云函数返回 ai_error_code 时存在），显示在气泡下方便于截图定位 */
  diagnostic?: string;
}

Page({
  data: {
    msgs: [] as ChatMsg[],
    input: '',
    sending: false,
    /** 底部是否固定「转人工 / 提交工单」出口 */
    showHumanCta: false,
    /** 快捷问题 */
    quickQuestions: [] as string[],
    /** 是否已开始对话（用于收起欢迎卡的快捷问题区） */
    chatStarted: false,
    scrollIntoView: '',
  },

  onLoad() {
    const welcome: ChatMsg = {
      id: this.nextId(),
      role: 'bot',
      content: '',
      welcome: true,
    };
    this.setData({
      msgs: [welcome],
      quickQuestions: ['怎么预约座位？', '违约会有什么后果？', '收不到预约通知怎么办？', '怎么联系人工客服？'],
    });
    this.scrollBottom();
  },

  nextId(): string {
    return `m${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  },

  onInput(e: WechatMiniprogram.CustomEvent<{ value?: string }>) {
    this.setData({ input: (e.detail && e.detail.value) || '' });
  },

  /** 快捷问题点击 */
  onQuickTap(e: WechatMiniprogram.TouchEvent) {
    const q = (e.currentTarget.dataset.q as string) || '';
    if (!q) return;
    this.setData({ input: q });
    this.send();
  },

  async send() {
    const text = (this.data.input || '').trim();
    if (!text || this.data.sending) return;
    const userMsg: ChatMsg = { id: this.nextId(), role: 'user', content: text };
    this.setData({
      msgs: [...this.data.msgs, userMsg],
      input: '',
      sending: true,
      showHumanCta: false,
      chatStarted: true,
    });
    this.scrollBottom();

    try {
      const res = await callCloud('aiChat', {
        action: 'chat',
        msg: text,
        from: 'aiChat',
        // 最近 3 轮上下文（跳过欢迎卡片等空 content）
        history: this.data.msgs
          .filter((m) => !m.welcome && m.content)
          .slice(-6, -1)
          .map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })),
      });
      const d =
        (res && (res as { data?: { reply?: string; need_human?: boolean; ai_error_code?: string } }).data) || {};
      const reply = (d.reply || '').trim();
      const needHuman = !!d.need_human;
      const diag = typeof d.ai_error_code === 'string' ? d.ai_error_code : '';
      if (diag) {
        // 云端降级走的是「成功返回」，不会进 catch，前端日志本来干干净净；
        // 必须主动打出来，否则排查只能靠云开发控制台的 console.error。
        console.warn('[aiChat] 云端降级，诊断码 =', diag);
      }
      const botMsg: ChatMsg = {
        id: this.nextId(),
        role: 'bot',
        content: reply || '我暂时没想到好答案，建议转人工或提交意见反馈。',
        diagnostic: diag || undefined,
      };
      this.setData({
        msgs: [...this.data.msgs, botMsg],
        showHumanCta: needHuman,
        sending: false,
      });
    } catch (err) {
      // 客服场景不弹系统模态框：JSON 化错误进气泡降级文案（最后一帧 N 条日志便于排查）
      this.setData({ sending: false });
      let detail = '';
      if (err && typeof err === 'object') {
        const e = err as { errMsg?: unknown; message?: unknown };
        const raw = typeof e.errMsg === 'string' ? e.errMsg : typeof e.message === 'string' ? e.message : '';
        detail = raw ? raw.slice(0, 300) : '';
      } else if (typeof err === 'string') {
        detail = String(err).slice(0, 300);
      }
      console.warn('[aiChat] 云函数调度失败', detail, err);
      const botMsg: ChatMsg = {
        id: this.nextId(),
        role: 'bot',
        content:
          detail && detail.indexOf('timeout') >= 0
            ? 'AI 客服这次响应超时了（网络或服务繁忙）。你可以稍后再问我一次，或点下方「提交工单」让管理员跟进。'
            : 'AI 客服暂时没接通，请你稍后再试；也可以点下方「提交工单」或到「常见问题」里找答案。',
      };
      this.setData({ msgs: [...this.data.msgs, botMsg], showHumanCta: true });
    }
    this.scrollBottom();
  },

  scrollBottom() {
    setTimeout(() => {
      const last = this.data.msgs[this.data.msgs.length - 1];
      if (last) this.setData({ scrollIntoView: `msg-${last.id}` });
    }, 50);
  },

  goFaq() {
    wx.navigateTo({ url: '/subpages/faq/faq' });
  },

  goFeedback() {
    wx.navigateTo({ url: '/subpages/feedback/feedback' });
  },

  /** 「转人工客服」直接打开原生客服会话按钮在 wxml 里（open-type=contact），这里只做跳 FAQ 的兜底 */
  onContact() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onShareAppMessage() {
    return { title: '专注座 · AI 客服', path: '/pages/home/home' };
  },
});