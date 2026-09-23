Component({
  properties: {
    title: { type: String, value: '出错了' },
    description: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },
  methods: {
    onActionTap() {
      this.triggerEvent('action');
    },
  },
});