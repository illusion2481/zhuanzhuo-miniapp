import { fetchStudyRank, RankBoard, RankEntry, RankResult, RankPeriod } from '../../services/record'
import { getCachedUser } from '../../services/auth'
import { buildShare } from '../../utils/share'

const BOARDS: { key: RankBoard; label: string }[] = [
  { key: 'focus', label: '专注榜' },
  { key: 'checkin', label: '签到榜' },
]

const PERIODS: { key: RankPeriod; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'all', label: '总榜' },
]

function formatFocusSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '0m'
}

function firstChar(name: string): string {
  const trimmed = (name || '').trim()
  return trimmed ? Array.from(trimmed)[0] : '座'
}

Page({
  data: {
    boards: BOARDS,
    activeBoard: 'focus' as RankBoard,
    periods: PERIODS,
    activePeriod: 'week' as RankPeriod,
    list: [] as RankEntry[],
    me: null as RankResult['me'],
    loading: false,
    errorText: '',
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load(() => wx.stopPullDownRefresh())
  },

  async load(done?: () => void) {
    if (this.data.loading) {
      if (done) done()
      return
    }
    this.setData({ loading: true, errorText: '' })
    try {
      const period = this.data.activePeriod
      const board = this.data.activeBoard
      const res = await fetchStudyRank(period, board)
      const cached = getCachedUser()
      const meId = cached ? cached.userId : ''
      const list = (res.top || []).map((r: RankEntry) => ({
        ...r,
        char: firstChar(r.name),
        is_me: !!meId && r.user_id === meId,
      }))
      this.setData({ list, me: res.me, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      this.setData({ loading: false, errorText: msg })
    } finally {
      if (done) done()
    }
  },

  onSwitchBoard(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as RankBoard
    if (key === this.data.activeBoard) return
    this.setData({ activeBoard: key, me: null }, () => this.load())
  },

  onSwitchPeriod(e: WechatMiniprogram.BaseEvent) {
    const key = e.currentTarget.dataset.key as RankPeriod
    if (key === this.data.activePeriod) return
    this.setData({ activePeriod: key }, () => this.load())
  },

  fmtFocus(sec: number): string {
    return formatFocusSec(sec)
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  onShareAppMessage() {
    return buildShare({
      title: '我在专注座的学习排行榜上，来一起卷专注力',
      path: 'subpages/rank/rank',
    });
  },
})
