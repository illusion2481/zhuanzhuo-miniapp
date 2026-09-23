Component({
  properties: {
    title: { type: String, value: '暂无内容' },
    description: { type: String, value: '' },
    /** 插画 emoji，默认友好图标 */
    icon: { type: String, value: '🗂️' },
    /** 是否显示“重试”按钮 */
    retryable: { type: Boolean, value: false },
    retryText: { type: String, value: '重试' },
  },
  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});