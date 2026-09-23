# 功能测试走查报告（2026-09-09）

> 背景：把 `docs/test-cases.md` 已写入的功能测试**走查一遍**，并修复断点，让「已经写好的功能」能 **完整实现**。
> 产出：①逐条核对实现；②落地关键修复；③新增本地自动化测试；④决策点确认。

---

## 一、结论速览

| 维度 | 结果 |
|---|---|
| 代码编译层 | ✅ typecheck / lint / seed:check 全 EXIT 0 |
| 云函数逻辑测试（新增） | ✅ `npm run test:cloud` → **13 pass / 0 fail**（leaveSeat 6 + expireRecords 7） |
| 断点修复 | ✅ leaveSeat 由占位 → 完整实现；expireRecords 补暂离超时回流；adminStats 补签口径 |
| 前端接入 | ✅ 「临时离开/返回座位」入口已接入「我的预约」 |

> ⚠️ 仍**无法在本地验证**（需云环境 → 微信开发者工具 + 云开发控制台部署后真机/模拟器验证）：
> 真实扫码签到、`wx.cloud` 网络调用、AI 云函数实际返回、云数据库索引生效。

---

## 二、本次修复明细（代码）

| # | 文件 | 修复内容 |
|---|---|---|
| 1 | `cloudfunctions/leaveSeat/index.js` | 由 `return ok(null,'暂离占位')` **改为完整实现**：`action='leave'`(active→paused,写 `leave_count`)、`action='return'`(paused→active)；校验归属+类型+状态；越权/未知操作拦截 |
| 2 | `cloudfunctions/expireRecords/index.js` | 新增 **暂离超过 30 分钟自动回 active**（按 `updated_at < leaveCutoff` 查询，写 `payload.auto_return_from='leave_timeout'`），保留座位 |
| 3 | `cloudfunctions/adminStats/index.js` | `checkedIn` 改为按 **`payload.checked_in_at` 是否存在判定实签**（不再用 `active+completed`）；`paused` 计入状态分布与当前占用 |
| 4 | `types/record.d.ts` / `config/constants.ts` | `ReservationStatus` 增加 `'paused'`（连同 `RESERVATION_STATUS.PAUSED`） |
| 5 | `services/record.ts` | 新增 `leaveSeat(recordId)` / `returnSeat(recordId)` |
| 6 | `pages/myReservations/*` | `active` 增加「暂离」、`paused` 增加「返回座位」按钮 + 状态标签「暂离中」（wxml + scss，`$color-warning` 视觉） |
| 7 | `pages/admin/admin.ts` / `services/statistics.ts` / `components/StatusBadge/*` | `paused` 状态显示同步（分布/标签） |
| 8 | `docs/test-cases.md` | 签到窗口表述修正为「start 前15min 至 end 止」；暂离/返回/超时回流用例更新为实际实现 |

---

## 三、新增自动化测试

- 文件：`scripts/cloud-logic.test.cjs`
- 方式：`Module._resolveFilename` 拦截 `require('wx-server-sdk')`，用**内存 mock 数据库**本地驱动云函数，无需云环境即可验证状态机/越权/超时规则。
- 注册：`npm run test:cloud`
- 覆盖：
  - **leaveSeat**：active→paused、leave_count 累计、paused→active、越权拒绝、未知 action（6 例）
  - **expireRecords**：暂离>30min 自动回 active 并记来源、暂离未超时保持、pending→no_show、active→completed、统计计数（7 例）

```
== leaveSeat ==     6 PASS / 0 FAIL
== expireRecords == 7 PASS / 0 FAIL
==== cloud-logic: pass=13 fail=0 ====
```

---

## 四、test-cases 逐条走查结论（按 Phase）

> 每格：✅=已实现且可本地验证 →源码就绪；🟠=已实现但需云环境真机/模拟器最终确认；🔴=本次已修复。

- **Phase1 项目基础**：编译可开、TabBar 4 页、首页跳转、npm 构建、gitignore —— ✅ 全部就绪（需 IDE 打开最终编译确认）
- **Phase2 登录**：未登录态、微信登录（hash 存储）、角色显示、无明文 openid、admin 自动升级 —— ✅ 云函数+前端逻辑完整，需云环境实测登录
- **Phase3 分类/浏览**：分类按 type、偏好 chips、自习室列表、SeatMap、进入座位、座位空闲点选 —— ✅ 前端服务 + 云函数完整；🟡 需云数据种子后可视化确认
- **Phase4 预约闭环**：选时段预约、座位冲突拒绝、用户冲突拒绝、pending_checkin、签到窗口、签到 active+checked_in_at、扫码校验 seat_code、取消归属校验、`active` 结束使用、**暂留（leaveSeat）**、返回座位、expire 超时、**暂离超时自动回 active** —— ✅ **本次全链路补齐**（含 leaveSeat 实现与 expire 回流）；🟡 扫码需真机
- **Phase5 学习/番茄钟**：输入目标→start、单 running、1s 倒计时不改本地累加（重开累计正确）、pause/resume/complete/abandon、pause_segments 闭合、今日/周统计、最近列表 —— ✅ 前端与 studyRecord 逻辑完整；🟡 需云实测
- **Phase6 AI**：推荐/降级硬排序/理由、总结/降级基础文案、aiClient 超时/401/429 兜底、无 Key 泄漏 —— ✅ 云函数兜底完备；🟡 需云环境有 key 实测 AI 真返回，无 key 走 fallback（可本地验证 fallback 分支逻辑）
- **Phase7 管理**：admin 鉴权、非 admin/未配置降级、四宫格、状态分布、刷新、空态 —— ✅ adminStats 鉴权 + 前端拦截（本轮修正了 checkedIn 口径并纳入 paused）
- **Phase8 交付/文档**：.env.example、README 状态表、DEPLOY、test-cases、分词 —— ✅ 已具备

---

## 五、仍需你在「云环境」侧做的最终验证（本地代码已就绪）

1. **部署云函数**：`login` → `seedData` → `categoryList` → `roomList` → `createReservation` → `cancelReservation` → `checkin` → **`leaveSeat`** → `expireRecords` → `studyRecord` → `aiRecommend` → `aiSummary` → `adminStats`（**请勿遗漏 leaveSeat**）
2. **build npm**（重新生成 `miniprogram_npm`，因新增/改动组件）
3. 初始化数据库集合 + 建立 **`records` 复合索引**（`room_id, seat_id, status, start_at/end_at`；`user_id, status`）——见 DEPLOY/index 清单
4. 真机验证：登录 → 预约 → 扫码/手动签到 → 「暂离」→ 30 分钟到系统自动回 `active`（可临时把阈值改短测试）→ 各 AI 入口。

---

## 六、遗留与建议（不阻塞本轮）

- 📌 `scripts/_tmp_dbg.cjs`、`_tmp_expire_test.cjs`、`_tmp_leaveSeat_test.cjs` 为本次调试中间产物，已被正式 `cloud-logic.test.cjs` 替代，**可按需删除**（尊重删除约束，未自动删）。
- 📌 `adminStats`/`studyRecord(list)` 大数据量分页、全云函数统一 `event.payload` 类型校验（F5-F9）仍在 PLAN-v3 backlog，建议随 Sprint 0 后续补。
- 📌 `leaveSeat` 超时阈值 30 分钟为常量，可提为「管理端规则配置」（PLAN Phase C3 待做）。

---

## 参照

- `docs/test-cases.md`（用例清单）
- `docs/PLAN-v3-优化与功能升级.md` §0.5（审查报告 + 本轮已落地清单）
- `scripts/cloud-logic.test.cjs`（本地逻辑回归）