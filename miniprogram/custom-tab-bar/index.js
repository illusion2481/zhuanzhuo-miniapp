/* ══════════════ 自定义 tabBar（按角色渲染） ══════════════
 * 微信原生 tabBar 不支持运行时增删 tab（list 必须在 app.json 固定）。
 * 本项目采用「自定义 tabBar」：管理员显示 5 个 tab（含后台），
 * 普通用户显示 4 个（不渲染「后台」，界面无任何后台字样）。
 *
 * 注意：
 * - app.json 的 tabBar 仍需保留全部 5 个 pagePath（switchTab 校验依赖它），
 *   是否“看得见”由本组件控制。
 * - admin 页自身已有 role 校验（非管理员 authorized=false），防止通过 URL 直进。
 * - selected 当前选中页由组件在 pageLifetimes.show 时按路由自动计算，
 *   无需在各 tab 页 onShow 里手动 setData。
 *
 * ⚠️ 本文件必须是纯 JS：custom-tab-bar 是内置目录，index.js 直接运行，
 * 不经 TS 编译。任何类型注解/泛型都会在真机上直接报语法错误。
 */
var TAB_LIST = [
  {
    pagePath: '/pages/home/home',
    text: '首页',
    iconPath: '/assets/tab/home.png',
    selectedIconPath: '/assets/tab/home-active.png',
  },
  {
    pagePath: '/pages/rooms/rooms',
    text: '自习室',
    iconPath: '/assets/tab/rooms.png',
    selectedIconPath: '/assets/tab/rooms-active.png',
  },
  {
    pagePath: '/pages/study/study',
    text: '学习',
    iconPath: '/assets/tab/study.png',
    selectedIconPath: '/assets/tab/study-active.png',
  },
  {
    pagePath: '/pages/profile/profile',
    text: '我的',
    iconPath: '/assets/tab/profile.png',
    selectedIconPath: '/assets/tab/profile-active.png',
  },
  {
    pagePath: '/pages/admin/admin',
    text: '后台',
    iconPath: '/assets/tab/admin.png',
    selectedIconPath: '/assets/tab/admin-active.png',
  },
];

/** 后台 tab 在 list 中的下标（普通用户列表在其前截断） */
var ADMIN_INDEX = 4;

/** 读取当前用户（内存 globalData 优先，回退 storage 缓存） */
function readRole() {
  try {
    var app = getApp();
    var info = app && app.globalData && app.globalData.userInfo;
    if (info && info.role === 'admin') return true;
    var cached = wx.getStorageSync('focusseat_user');
    if (cached && cached.role === 'admin') return true;
    return false;
  } catch (err) {
    return false;
  }
}

Component({
  data: {
    list: [],
    selected: 0,
    isAdmin: false,
  },

  lifetimes: {
    attached: function () {
      this.refresh();
    },
  },

  pageLifetimes: {
    /** 每次页面展示都刷新（角色可能刚变：登录/切换账号） */
    show: function () {
      this.refresh();
      // 兜底：tab 切换瞬间 getCurrentPages 栈顶可能还是上一页，导致 selected
      // 算出过期值（表现为「上一页的图标一直高亮、点它没反应」）。等一拍再刷。
      var self = this;
      setTimeout(function () {
        self.refresh();
      }, 50);
    },
  },

  methods: {
    refresh: function () {
      var isAdmin = readRole();
      var list = isAdmin ? TAB_LIST : TAB_LIST.slice(0, ADMIN_INDEX);
      // 当前所在路由 → selected
      var selected = this.data.selected;
      try {
        var pages = getCurrentPages();
        var cur = pages[pages.length - 1];
        var route = cur && cur.route ? '/' + cur.route : '';
        if (route) {
          for (var i = 0; i < list.length; i++) {
            if (list[i].pagePath === route) {
              selected = i;
              break;
            }
          }
        }
      } catch (err) {
        /* 保持原值 */
      }
      this.setData({ list: list, selected: selected, isAdmin: isAdmin });
    },

    onTap: function (e) {
      var idx = Number(e.currentTarget.dataset.index);
      var item = this.data.list[idx];
      if (!item) return;
      // ⚠️ 不能用 this.data.selected 判断「重复点击」：selected 可能是过期值
      // （pageLifetimes.show 的路由计算时机不稳，会停在上一页），用过期值
      // early-return 会把目标 tab 点成「死图标」。改用实时路由对比。
      var cur = '';
      try {
        var pages = getCurrentPages();
        var top = pages[pages.length - 1];
        cur = top && top.route ? '/' + top.route : '';
      } catch (err) { /* 保持空串 */ }
      if (cur === item.pagePath) {
        // 已经在该页：仅纠正高亮（可能之前显示的是过期选中态）
        this.setData({ selected: idx });
        return;
      }
      var self = this;
      // 后台也是 tabBar 页，用 switchTab；非管理员不会出现在 list 里
      wx.switchTab({
        url: item.pagePath,
        success: function () {
          self.setData({ selected: idx });
        },
        complete: function () {
          // 兜底：等页面切换完成后再按真实路由刷一次，吞掉一切时序差
          self.refresh();
        },
      });
    },
  },
});