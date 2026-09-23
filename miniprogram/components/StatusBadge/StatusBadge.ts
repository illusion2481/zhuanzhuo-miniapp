Component({
  properties: {
    status: { type: String, value: 'free' },
    text: { type: String, value: '' },
  },
  data: {
    label: '',
  },
  observers: {
    'status, text'(status: string, text: string) {
      const map: Record<string, string> = {
        free: '空闲',
        reserved: '已预约',
        in_use: '使用中',
        'in-use': '使用中',
        maintain: '维护中',
        pending_checkin: '待签到',
        active: '进行中',
        paused: '暂离中',
        completed: '已完成',
        cancelled: '已取消',
        no_show: '已违约',
      };
      this.setData({ label: text || map[status] || status });
    },
  },
});
