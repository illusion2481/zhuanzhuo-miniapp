# 专注座（FocusSeat）优化与功能升级 Plan —— v3

> 依据：对比 GitHub 高收藏/高星自习室项目（xiaoxiaocxyer/studyroom · xiaozhangtansuo/SelfStudyRoom · SerendipityChina/LibOrder · xuan3689/StudyRoom · putong1024/10-studyRoom · P-Peaceful/wx-study-room）与当前「专注座」现状的差距分析。
>
> 当前定位：专注座在核心预约闭环（浏览 → 选座 → 预约 → 签到 → 暂离 → 番茄钟 → 学习记录 → 统计 → AI 辅助 → 管理后台）上已**超越**绝大多数社区项目。因此本 Plan **不以功能堆砌为目标，而是以「商业化闭环 + 复购黏性 + 场景数据 + 平台化」为主线**补齐真正缺失的高价值能力。

---

## 0. 差距速览（为什么是这些方向）

| 高收藏项目共性能力 | 专注座现状 | 差距 | 优先级 |
|---|---|---|---|
| 支付 / 会员 / 储值 / 卡券套餐 | ❌ 无 | 缺商业模式闭环 | 🔴 P0 |
| 签到/核销、二维码/扫码自助签到 | ✅ 已做 | 可加二维码核销 | 🟢 增强 |
| 多门店 + LBS 附近查找 | ❌ 单房间模型 | 缺门店化/LBS | 🟡 P2 |
| 排行榜 / 组队 / 社交激励 | ❌ 无 | 缺社交与留存 | 🟠 P1 |
| 系统通知（预约/超时/违规提醒） | ⚠️ 部分（本地计时） | 缺订阅消息推送 | 🟠 P1 |
| 预约名单导出 / 数据看板 | ⚠️ admin 有统计 | 缺订阅消息/导出 | 🟠 P1 |
| 规则可配置（开放/截止/人数） | ⚠️ 常量为主 | 缺管理端可视化配置 | 🟠 P1 |
| 学习数据 → 目标/复盘/AI | ✅ 已有 AI | 可做目标系统与数据导出 | 🟢 中 |

---

## 1. 战略主线（三条，贯穿所有 Phase）

1. **留人**：把一次性预约变成「连续打卡 + 番茄钟 + 排行榜 + 目标」的长期学习行为养成。
2. **变现**：接入微信支付，跑通储值 / 会员卡 / 每日时长包的商业闭环（为比赛「商业价值」加分项铺路）。
3. **平台化**：把房间/座位/规则从代码常量抽取为云数据库配置，前台「只读展示 + 预约」，运营能力上收后台。

> ⚠️ 安全约束（必须遵守）：
> - 支付、会员、优惠券等涉及真实金钱的模块，**一律只做「演示/沙箱」态**，禁止接入真实商户密钥、禁止真实扣款、禁止把支付凭据写入前端/云函数源码。
> - 所有涉及开放授权、小程序订阅消息、微信支付资质申请的操作，**必须先停下来向用户说明**，由用户在微信公众平台/云开控制台操作。
> - 不读/不打印/不修改任何 token / .env / 密钥；不动项目目录之外的任何文件；不删除文件目录。

---

## 0.5 功能测试审查报告（2026-09-09 review）

> 依据：逐步读 `test-cases.md` 与 6 个核心源代码文件（createReservation / studyRecord / checkin / leaveSeat / expireRecords / adminStats / shared/auth），交叉核对测试文档 ↔ 实际实现 ↔ 前端调用点，找出**用例失效、死代码、未覆盖风险、测试文档与实现不一致**等问题。

### 🔴 P0 —— 功能失效 / 死代码（必须修）

| # | 文件 | 问题 | 影响的测试用例 |
|---|---|---|---|
| F1 | `cloudfunctions/leaveSeat/index.js` | **仍是占位实现**：`return ok(null, '暂离占位，Phase 5 实现')`。前端 `services/*.ts` 里**没有任何 `leaveSeat` 调用点**（grep 全部云函数调用仅 11 个，无 leaveSeat）。座位「暂离/返回」功能**从未接入**。 | test-cases Phase 4 行「暂离（leaveSeat）后状态为 paused，再次签到回到 active」——**永远无法通过** |
| F2 | `cloudfunctions/leaveSeat/index.js` | README/记忆声称「5.1 暂离/返回/超时 ✅」，实际死代码。**文档状态与实现不符**。 | 误导验收 |

### 🟠 P1 —— 实现与测试文档不一致（改文档或改实现二选一）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| F3 | `docs/test-cases.md` Phase 4 | 签到窗口表述为「start_at 前 15 分钟到 **start_at 后 15 分钟**」外无法签到；**实际 checkin 实现是 `now < start-15min` 拒绝，`now > end` 拒绝**（即窗口为「start-15min ~ end 全程」）。两者不一致，表述有误。 | 修正测试用例表述为「start_at 前 15 分钟起到 end_at 止」 |
| F4 | `README.md` / PLAN 状态表 | `expireRecords → pending_checkin → no_show`、`active → completed` 已在定时任务实现；但 `adminStats` 的 `checkedIn = active + completed` 把「预约到期自动 completed」也计入已签到口径，**与「签到 = 手动签到」语义冲突**。 | adminStats 应基于 `payload.checked_in_at` 有无判断"实签"，而非 status=completed |

### 🟡 P2 —— 未覆盖的边界 / 隐患（补测试或补实现）

| # | 位置 | 问题 | 建议新增用例 / 修复 |
|---|---|---|---|
| F5 | `createReservation` + `expireRecords` + `studyRecord(list)` `adminStats` | **多处查询无索引依赖 / 无分页**：冲突检测（room+seat+status+时间范围）、`limit(100)` / `limit(200)` / `limit(1000)` 单次拉取，数据量大于上限时**统计/清理由错或漏**。 | ① 建立 `records` 复合索引（room_id, seat_id, status, start_at/end_at）；② 定时任务/统计改为**循环分页**（`skip+limit` 或基于 `_id` 游标） |
| F6 | `studyRecord` `summary` / `list` | 无分页 + `limit(200)`，超 200 条学习记录时 `total_seconds`/`pomodoro_total` **漏统计**；`list` 也最多 100 条。 | 补分页；写用例「>200 条记录时统计仍准确」 |
| F7 | 所有云函数 | `event.payload` **未做类型校验**（只有 createReservation 校验了必填，category_ids/goal 未限长/限型），违反 test-cases `安全验收` 要求的「对所有 event.payload 进行类型校验（避免 NoSQL 注入）」。 | 抽 `shared/validator`，统一对 `event.*` 做白名单字段 + 类型 + 长度校验 |
| F8 | `expireRecords` | `Promise.all(100 条 update)` 并发写，超限时会触发云数据库并发上限；且 `pending`/`completed` 两段无事务，中断会造成部分更新。 | 分批串行或 `chunk` 控制并发；记录本轮处理 `request_id` 便于复查 |
| F9 | `checkin` | `event.seat_code` 扫码校验仅在触发时才做；但 `seat_code` 匹配是**字符串全等**（`record.seat_id !== scanned`），若座位号含空格/大小写差异会误拒。前端是否传入 seat_code 无统一约定。 | 明确前端扫码是否传 `seat_code`；统一 trim + 规范化比对 |
| F10 | `expireRecords` / `leaveSeat` | 「暂离超时（30 分钟）自动回到 active」在 test-cases 里写到，但**该逻辑后端从未实现**（leaveSeat 是占位），超时回流逻辑缺失。 | 若保留餐桌座位暂离需求 → 实现 leaveSeat + 超时定时任务；否则**删除这条测试用例**并明确"座位暂离不接入，番茄钟暂停已覆盖" |

### 🟢 P2 — 自动化测试缺失（对应 test-cases 末尾「待办」清单，仍为空）

| # | 建议新增自动化 | 说明 |
|---|---|---|
| F11 | studyRecord `computeActiveSeconds` 单元测试 | 多段 pause_segments 扣减正确性、跨天、暂停未闭合 |
| F12 | `createReservation` 冲突检测集成测试 | 座位冲突 + 用户冲突两分支返回码 |
| F13 | `adminStats` 统计口径快照测试 | `checked_in`/`no_show_rate` 口径回归 |
| F14 | `checkin` 时间窗边界 | start-15min 边界、end 边界、超时拒绝 |

### ✅ 本次已落地修复（2026-09-09「走一遍功能测试」实操）

| 项 | 修复内容 | 文件 |
|---|---|---|
| F1/F2/F10 | leaveSeat 由占位改为**完整实现**：`action=leave`（active→paused，写 `leave_count`）、`action=return`（paused→active）、校验归属/类型/状态；**前端接入** `leaveSeat()`/`returnSeat()`，myReservations 增加「暂离」「返回座位」按钮 + `paused` 状态标签；expireRecords 增加**暂离>30min 自动回 active** 逻辑 | `cloudfunctions/leaveSeat/index.js`、`cloudfunctions/expireRecords/index.js`、`miniprogram/services/record.ts`、`pages/myReservations/*`、`pages/admin/*`、`components/StatusBadge/*`、`types/record.d.ts`、`config/constants.ts` |
| F3 | 修正 test-cases 签到窗口表述为「start前15min 至 end 止」 | `docs/test-cases.md` |
| F4 | adminStats `checkedIn` 改按 `payload.checked_in_at` 是否存在判定（实签），`paused` 计入占用/分布 | `cloudfunctions/adminStats/index.js`、`miniprogram/services/statistics.ts`、`pages/admin/admin.ts` |
| F11/F2 部分 | 新增**本地云函数逻辑测试** `scripts/cloud-logic.test.cjs`（13 用例：leave 状态机 + expire 超时处理），注册 `npm run test:cloud` | `scripts/cloud-logic.test.cjs`、`package.json` |

**验证结果（`npm run ...` 全部 EXIT 0）**：
- `typecheck` / `lint` / `seed:check` ✅
- `test:cloud` → leaveSeat 6 用例 + expireRecords 7 用例 = **13 pass / 0 fail** ✅

### ✅ Sprint 0 收尾落地（2026-09-11，本轮）

> F5-F9 与 F11-F14 全部落地，`test:cloud` 扩至 **84 例 / 0 fail**。

| 项 | 落地内容 | 文件 |
|---|---|---|
| F5/F8 | `shared/db.fetchAllPaged`（`_id` 游标循环分页）；expireRecords / adminStats / studyRecord-summary 全部改为分页拉全量；expireRecords 更新改为 **每批 20 条分批并发**，响应含 `processed_total` | `shared/db.{js,ts}`、`expireRecords/`、`adminStats/`、`studyRecord/` |
| F6 | studyRecord `list`/`list_reservations` 支持 `skip`/`page` 分页；`summary` 分页统计（>200 条仍准确，用例实测 240 条） | `studyRecord/index.js` |
| F7 | `shared/validator.validateEvent`（白名单剥离 + 类型 + 长度 + ISO + enum），**13 个云函数全部接入**（login/seedData/categoryList/roomList/createReservation/cancelReservation/checkin/leaveSeat/expireRecords/studyRecord/aiRecommend/aiSummary/adminStats） | `shared/validator.{js,ts}` + 13 个云函数 |
| F9 | checkin 扫码座位号统一 `normalizeSeatCode`（trim + 压缩空白 + 大写）比对，「A 01」vs「a01」不再误拒 | `checkin/index.js`、`shared/validator` |
| 🔴 修复 | **adminStats 鉴权 bug**：`assertAdminByOpenId()` 调用时未传参 → 对空串哈希 → **真实管理员也会被 FORBIDDEN**；改为 `getAuthContext()` 取 openId/hash 传入 | `adminStats/index.js` |
| 🔴 修复 | **studyRecord complete/abandon 数据丢失 bug**：`closeOpenPause` 返回结构错误，解构 `{ payload }` 拿到 undefined → `goal`/`pause_segments` 被静默清空（AI 总结目标分布失效）；回归用例锁定 | `studyRecord/index.js` |
| F11-F14 | 本地逻辑测试扩至 84 例：computeActiveSeconds（多段/跨天/未闭合）、createReservation 冲突、adminStats 鉴权+口径快照、checkin 时间窗边界+扫码、分页（250/240 条） | `scripts/cloud-logic.test.cjs` |
| 文档 | 修正「云部署清单」重复标题与 `reservation_id` 唯一索引误导（DEPLOY Q4 同步修正）；`records` 索引清单新增冲突检测复合索引 `rec_room_seat_type_status_start` | `docs/云部署与端到端验证清单.md`、`docs/DEPLOY.md` |

### 结论
- 代码 4 层验证（typecheck/lint/SCSS/token）是绿的，但**功能层存在 2 个 P0（leaveSeat 死代码 + 暂离未接入）、1 个实现与文档不一致（签到窗口表述）、多个无条件分页的统计隐患**。
- **优先处理 F1/F2/F4/F8**（影响正确性和文档可信度），再补 F5/F6 索引与分页，最后用 F11-F14 补自动化测试锁定。
- 这些属于「修复」而非「新功能」，建议**置于 Phase A 商业化之前**作为独立的「修复 Sprint 0」：先把系统测准、跑通，再往上叠新能力。

---

## Phase A —— 商业化 / 变现闭环（🔴 最高优先，建议最先做）

**目标**：从"纯功能工具"升级为"带商业模式的产品"，这是与高收藏项目拉开差距的关键。

### A1. 金额体系与钱包（不含真实支付）
- 云数据库新增 `wallets`、`charge_records` 集合。
- 用户可用体验额度/充值（沙箱）购买「按时长座位」与「会员卡」。
- **不做真实扣款**，做成演示态（`MOCK_PAY=1`）。

### A2. 会员 / 卡券体系
- `memberships`（会员等级、权益：每日免费时长、优先选座、无广告）。
- `packages`（时长套餐、次卡、周卡/月卡，参照 wx-study-room 的卡券套餐 + 储值卡）。
- `coupons`（优惠券：新人券、满减券、签到券）。

### A3. 支付抽象层
- 云函数 `pay/`：`createOrder` / `queryOrder` / `mockPay`（沙箱） / `recharge`。
- 前端 `services/pay.ts` + 订单页，保持 `callCloud` 统一契约。
- 仅预留 `wx.requestPayment` 接口骨架，接真机需用户申请商户号后启用。

### A4. 商业化看板
- admin 增加 `收入统计`：套餐售卖、会员数、充值流水、（沙箱）成交额。

**交付物**：`stores`(会员/钱包)/`coupons`/页面 `recharge`、`myMembership`、`myCoupons`；`docs/pay.md` 说明沙箱与真实支付的边界。

---

## Phase B · 会员体验与数据防丢（🟠 高，增强黏性）

### B1. 订阅消息推送
- 换 `wx.requestSubscribeMessage` 订阅「预约开始前提醒」「暂离超时提醒」「到期归还提醒」。
- 云函数 `notify/`（`subscribeMessage.send`）由 `expireRecords` 定时任务触发。
- 需要用户在小程序后台申请订阅消息模板，**先说明再操作**。

### B2. 目标 / 连续打卡系统
- 新集合 `goals`（目标：本周专注 X 小时 / 连续打卡 X 天）。
- 番茄钟结束后自动写 `day_stats`，支持「连续打卡 streak」+ 周目标进度条。
- 首页/学习页展示「今日进度 + streak + 距目标还差多少」。

### B3. 社交激励与排行榜
- 在 `studyRecord` 基础上聚合「周专注时长」「打卡天数」榜单。
- `leaderboard/` 云函数 + 首页榜单入口（可匿名 top10，保护隐私）。
- （可选）好友 PK / 组队打卡，参照 `chetanbuluo/StudyRoom` 的"邀请组队"。

### B4. 退款退座 / 履约避免规则
- 「爽约 N 次 → 24h 禁约」黑名单机制（呼应 `10-studyRoom` 的违规管理）。
- 预约规则从常量下沉到 `config/rooms`，管理端可配（开放时间、最大预约时长、提前取消时限）。

**交付物**：`notify/` 云函数、`goals` + `day_stats` 扩展、`ranking` 页面 + `ranking/` 云函数、`penalty` 规则、admin「规则配置」。

---

## Phase C · 平台化 / 门店与导出（🟡 中，扩展性）

### C1. 预约二维码核销
- 预约成功后生成二维码（可选，参照 `wx-study-`/`SelfStudyRoom` 的扫码签到）。
- 用 `wx.cloud` 小程序码或 canvas 生成，admin 扫码核销入席。

### C2. 用户名单导出
- admin 查看预约名单，支持导出 CSV/Excel（`xlsx` 在云函数生成，返回临时链接）。
- 呼应 `SelfStudyRoom` 的「名单导出 Excel、打印」。

### C3. 房间/座位从代码下沉到数据库
- `rooms`/`seats` 改为库表驱动，支持 `维护中`状态、区域/楼层筛选、更细座位状态（损坏/预留）。
- 为后续多门店铺路，`stores`(门店) + `store_id` 外键。
- home 支持附近推荐（LBS，`wx.getLocation`）——**地理合规**（详见下方约束）。

---

## Phase D · 工程与质量硬化（贯穿）

### D1. 支付/通知服务层契约统一
- 上层服务胶水薄：`callCloud` 已有，所有新云函数同样遵守 `{success,data,message}`。

### D2. 测试与回滚
- 扩展 `docs/test-cases.md`：支付、会员、排行榜、订阅推送、规则配置。

### D3. 数据看板
- admin 已有统计，补充：使用率热力图、热门时段、留存漏斗、爽约率。

### 后端加固
- 云函数鉴权统一，`shared/auth` 从占位补齐，参考 adminStats 的 `ADMIN_OPENID_HASHES` 模式。

---

## 推荐执行顺序（拆成可独立验收的 commit 块）

> **⚠️ 先做「修复 Sprint 0」**：上文 §0.5 的 P0/P1 问题（F1/F2 leaveSeat 死代码、F4 签到口径）必须**先于任何新功能**修复，否则叠在坏地基上越积越难测。Sprint 0 单独验收、单独 commit。

### Sprint 0 · 功能测试修复（先做）

| 顺序 | 模块 | 建议 commit message（英文） |
|---|---|---|
| 0.1 | 删除/重接 leaveSeat 死代码，明确座位暂离是否接入 | `fix(leaveSeat): remove dead stub or wire seat leave flow` |
| 0.2 | 修正签到窗口测试文档表述（start-15min ~ end） | `docs(test-cases): correct checkin window wording` |
| 0.3 | adminStats 基于 `payload.checked_in_at` 判定实签口径 | `fix(adminStats): checkedIn based on check-in timestamp` |
| 0.4 | records 复合索引 + 统计/定时任务循环分页 | `fix(records): add index & paginate aggregations` |
| 0.5 | `shared/validator` 统一 event.payload 类型校验 | `feat(shared): unify payload validator` |
| 0.6 | 补 F11-F14 自动化测试（tomato/conflict/admin/checkin） | `test(study): add unit & integration cases` |

### 新功能（Sprint 1+）

| 顺序 | 模块 | 建议 commit message（英文） | 依赖 |
|---|---|---|---|
| 1 | 金额/钱包/套餐数据结构 + 沙箱支付 | `feat(wallet): wallet & mock-pay sandbox` | — |
| 2 | 会员/优惠券/储值页 | `feat(membership): membership & coupon pages` | 1 |
| 3 | 订阅消息 `notify` 云函数 | `feat(notify): subscribe-message notify` | — |
| 4 | 目标/打卡/榜单 | `feat(goals): streak & ranking leaderboard` | studyRecord |
| 5 | 违规禁约 + 规则可配置 | `feat(penalty): penalty & room rule config` | createReservation |
| 6 | 二维码核销 + 导出 | `feat(verify): qrcode check-in & export` | admin |
| 7 | 多门店/LBS/数据下沉 | `refactor(stores): store & seat data-driven` | rooms |
| 8 | 看板增强 | `feat(stats): usage & funnel dashboard` | adminStats |

---

## 7. 不建议做（陷阱区，避免陷入低价值堆砌）

- ❌ 大改技术栈（切 uni-app 等）——当前 TDesign + 原生很稳，迁移成本巨大且无收益。
- ❌ 真实接入微信支付/真实商户号（涉钱、涉资质）。
- ❌ 过度社交化（复杂聊天/直播），偏离"学习工具"定位。
- ❌ 纯为数量增添同质页面（如"好书推荐"，除非有真实内容源）。

---

## 8. 一句话总结

专注座在**已覆盖**核心预约 + 番茄钟 + 统计 + AI 辅助 + 管理后台，已大幅领先社区同类。下一步最值得投入的是 **A(商业化沙箱闭环) + B(留存/社交/规则)**，这两条主线能让项目从"毕设级功能演示"升级为"可演示商业价值的产品"，也更贴合比赛评审看重的能力成熟度与数据看板。

---

### 附：参照项目清单（本 Plan 的灵感来源）

- `xiaoxiaocxyer/studyroom`（71★）——典型毕设级预约 + 管理后台。
- `xiaozhangtansuo/SelfStudyRoom`（云开发原生，扫码签到/导出/规则）。
- `SerendipityChina/LibOrder`（馆藏 + 自习预约，公告/动态/榜单）。
- `xuan3689/StudyRoom`（多平台 uni-app，支付 + 二维码 + 会员 + 评价）。
- `putong1024/10-studyRoom`（违规管理/黑名单/计时计费/规则配置）。
- `P-Peaceful/wx-study-room`（余额充值/卡券套餐/排行榜/储值卡）。