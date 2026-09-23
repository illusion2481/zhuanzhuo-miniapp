# 「专注座」UI / 排版优化 Plan

> 目标：在不推倒架构的前提下，消除「简陋感」，把 9 个页面的排版、用色、反馈打磨到一致的档次。
> 原则：**先一致性，再精致度；先消除 bug，再调审美**。全部为前端改动，不触碰云函数与数据。
> 状态：P0 已修，其余待用户确认后分批实施。

---

## 现状一句话结论

首页（home）已经比较考究（渐变英雄区 + AI 卡片 + 质感弹窗），但**其它 8 页质量参差**：
- 标题字号/颜色**4 种各说各话**；
- 「橙」警示色同一个语义出现 **3 个值**（#e09f3e / #f1b429 / #b07d13）；
- 三处页面有 **20 处左右的裸 rpx**，越旧的页面越乱；
- 空态/错误文案直接暴露「请部署 seedData 云函数」这类**开发提示**；
- 存在**死组件**（RoomCard/SeatCard/StatusBadge）与一处**会白屏的漏注册**。
- 个人中心没头像、tab 图标是 294B 占位小位图 ——「廉价感」的主要来源。

---

## P0 — 必修 Bug（1 项，会导致白屏）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 0.1 | `study.wxml` 用了 `<error-state>`，但 `study.json` 的 `usingComponents` 里**没注册 ErrorState**。`lazyCodeLoading` 下，一旦加载失败页面直接报错/白屏。 | `pages/study/study.json` | 补 `"/components/ErrorState/ErrorState"` 注册 |

> 这项是唯一影响「会不会坏」的，建议任何改动前先合入。

---

## P1 — 用色与标题一致性（品牌识别核心，改动集中）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 1.1 | 「橙（待处理/警示）」3 个值并存 | `seats.scss:61`（#f1b429）；`myReservations.scss:36/59/104/146`（#f1b429 / #b07d13） | 全部收敛到 token `$color-warning`(#e09f3e) 与派生 `rgba(224,159,62,…)` |
| 1.2 | `page-title` 三套字号/颜色：全局(40/600 绿)、reservation/admin(48/800 绿)、study(48/600 黑) | `app.scss` / `reservation.scss` / `admin.scss` / `study.scss` | `app.scss` 定唯一基准；删除各页覆盖；study 标题改回 `$color-primary` |
| 1.3 | 座位状态色除 token 外，`SeatMap`/`seats` 有内联 `#f1b429` 等魔法色 | `components/SeatMap.scss`、`seats.scss` | 状态着色统一走 `$color-seat-*` token |

---

## P2 — 清理与健壮性（让代码和页面都更干净）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 2.1 | 页面级注册不全，又堆在 app.json 全局，`lazyCodeLoading` 下按需加载顺序不稳 | `seats.json`、`myReservations.json` | 各自补注册 `t-qrcode`（myReservations 还缺）、`t-popup`、`t-button` |
| 2.2 | 死组件：`room-card` 注册未用；`SeatCard`/`StatusBadge` 整个无人用；`seats.scss` 的 `.time-section` 写了没用 | `rooms.json`、`components/SeatCard*`、`components/StatusBadge*`、`seats.scss` | 确认无引用后摘除/移除，避免「改两套」 |
| 2.3 | 空态/错误文案面向开发者 | `rooms.wxml`/`seats.wxml`/`admin.wxml` | 统一为「服务暂不可用，请稍后重试」「暂无座位，试试别的时段」等用户话术 |
| 2.4 | `SeatMap` 座位尺寸/坐标硬编码（`GUTTER_LEFT`/`CELL`/`SEAT`），且 wxml 内联写死 width/height | `SeatMap.ts`/`.wxml` | 尺寸改由 token + 页面级可配，收拢硬编码 |

---

## P3 — 精致度提升（「简陋感」的最后杀手）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 3.1 | 个人中心无头像/无视觉锚点 | `pages/profile/*` | 用用户名首字做**圆形色块头像**（无需云存储），头像 + 昵称 + 角色 | 3 层留白 |
| 3.2 | `EmptyState` 无图标/插画，有内容前全是灰字 | `components/EmptyState*` | 引入 `t-empty` 或内联简洁插画；文案改用户话术 |
| 3.3 | tab 图标是 294B 占位位图，`borderStyle:"black"` 分隔线突兀 | `app.json`、`assets/tab/*` | 换 81px 高清 png 或改字体图标；`borderStyle:"white"` |
| 3.4 | 原生 `button`（reservation 页 4 键、admin `refresh`）无 loading/禁用，存在连点 | `reservation.wxml`、`admin*` | 无 loading/disabled；admin refresh 加防重 |
| 3.5 | 最小字号溢出体系：`checkIn-qr__tip`20rpx、`chart-bar-value`18rpx、`timer-value`80rpx | `myReservations.scss`、`study.scss` | 收进 token（新增 `$font-size-2xs`/`$size-stat-hero`） |
| 3.6 | 每页留白节奏不一：`rooms.box-room` 内边距仅 16rpx、`myReservations` 卡片动作区 4 键在窄屏挤两行 | `rooms.scss`、`myReservations.scss` | 统一卡片留白 + 动作区改 grid/等分 |
| 3.7 | 拿到即时下的加载反馈不一：`LoadingState`/空态遮罩可进一步统一转场 | 全局 | 统一 loading 转圈 + 过渡动画时机 |
| 3.8 | `admin` 刷新无 loading；re-enter 无 refresh | `admin.wxml` | 刷新按钮绑 loading/disabled |

---

## 建议分 4 批实施（每批单独验收 + 编译确认）

**第一轮（先修不坏，10 分钟内）**
- 0.1 补 `study.json` 注册 error-state
- 1.1 收敛橙警示色
- 1.2 统一 page-title
- 1.3 座位状态 token 化

**第二轮（清理 + 文案，不会改观即先干净）**
- 2.1 页面级补注册组件
- 2.2 清理死组件/死样式
- 2.3 空/错态用户话术

**第三轮（精致度，最提印象分）**
- 3.1 profile 头像
- 3.2 EmptyState 插画
- 3.3 tab 图标 & borderStyle
- 3.4 原生按钮 loading/防连
- 3.5 字号 token 化

**第四轮（收尾对账）**
- 3.6 卡片留白/动作区 grid
- 3.7 转场动画一致
- 3.8 admin 反馈
- 全量 `npm run typecheck` + `lint` + `node scripts/cloud-logic.test.cjs` 回归

---

## 验收标准

- 同一语义颜色全 app 唯一（橙、绿、红各 1 个主 token）
- 所有页面 `page-title` 字号颜色一致
- 无残留裸 `rpx` 越 `$spacing-*` / `$font-size-*` 体系
- 空态 ≥ 图标，文案均为用户话术，含「重试」入口
- typecheck / lint / 测试套件全绿

---

## 不做（明确排除）

- ❌ 换技术栈（uni-app/Vue/小程序原生版、云函数语言重写）
- ❌ 改动任何云函数逻辑、数据 schema
- ❌ 引入新 UI 框架 / 大改组件库