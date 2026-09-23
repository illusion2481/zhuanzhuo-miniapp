# 测试用例（按 Phase 分组）

> 所有用例均可勾选。CI 自动化部分见末尾。

---

## Phase 1 · 项目基础

- [ ] 微信开发者工具可打开项目并编译（无 tsc / sass / eslint 红字）
- [ ] TabBar 四个页面（首页 / 自习室 / 学习 / 我的）可正常切换
- [ ] 首页品牌信息展示，按钮可点击跳转
- [ ] `npm install` 与「工具 → 构建 npm」成功
- [ ] `.gitignore` 能阻止 `.env`、`node_modules`、`miniprogram_npm/` 被追踪

## Phase 2 · 登录与用户档案

- [ ] 未登录时进入「我的」页显示「未登录」+「微信登录」按钮
- [ ] 点击「微信登录」调 `login` 云函数成功，昵称显示为默认值或真名
- [ ] 「我的」页根据 role 显示身份（学生 / 管理员）
- [ ] `users` 集合中无明文 openId 字段（**安全验收**）
- [ ] `ADMIN_OPENID_HASHES` 配置后，新登录用户 role 自动为 admin

## Phase 3 · 分类与浏览

- [ ] `categoryList` 云函数按 `type` 返回对应分类
- [ ] 首页偏好 chips 来自 `seat_feature` 类型分类
- [ ] 「自习室」页面展示自习室列表（含座位数、设施）
- [ ] 「座位」页面渲染 `SeatMap` 组件（颜色标识空闲 / 占用）
- [ ] 点击自习室 → 进入对应座位页
- [ ] 座位状态为空闲时可点击进入预约

## Phase 4 · 预约业务闭环

- [ ] 「预约」页选择时间段 → 调 `createReservation` 成功
- [ ] 同一座位同时间段重复预约被后端拒绝（错误码明确）
- [ ] 预约成功后状态为 `pending_checkin`
- [ ] 签到时间窗口（start_at 前 15 分钟起，到 end_at 为止）内可签到；窗口外（过早/已结束）报错
- [ ] 签到成功状态变为 `active`，`payload.checked_in_at` 写入当前时间
- [ ] 扫码签到：扫描的 seat_code 与预约座位不一致时被拒绝
- [ ] 取消预约校验归属（只能取消自己的）
- [ ] `active`（使用中）状态可「结束使用」→ `cancelled`；`pending_checkin` 可「取消预约」
- [ ] 暂离：`active` → `paused`（`leaveSeat` 云函数 `action=leave`）
- [ ] 返回座位：`paused` → `active`（`leaveSeat` action=return）
- [ ] `expireRecords` 定时触发：`pending_checkin` → `no_show`、`active` → `completed`
- [ ] 暂离超时（30 分钟）自动回到 `active`（座位保留）并写入 `payload.auto_return_at`

## Phase 5 · 学习记录与番茄钟

- [ ] 「学习」页可输入目标、点击「开始学习」调 `studyRecord:start`
- [ ] 单人同时只能有一个 `running` 状态的记录（防止误开）
- [ ] 番茄钟 1s 刷新倒计时，**不依赖前端 setInterval 的准确性**（关闭页面后重新打开能正确累加）
- [ ] 暂停 / 继续 / 完成 / 主动放弃四个动作均能成功更新状态
- [ ] `payload.pause_segments` 正确闭合（暂停段 end 时间戳到位）
- [ ] 「今日统计」卡片显示当日完成番茄数与专注分钟数
- [ ] 「本周统计」卡片显示本周完成番茄数与活跃天数
- [ ] 「最近学习」列表显示状态标签（completed / abandoned / running）

## Phase 6 · AI 能力

- [ ] 首页输入目标 + 偏好 + 时长 → 调 `aiRecommend` 返回推荐列表
- [ ] AI 推荐失败时降级为基于座位属性的硬排序（页面不崩溃）
- [ ] 推荐卡片显示推荐理由（来自 AI 文案 或 硬排序规则）
- [ ] 「学习」页点击「AI 学习建议」调 `aiSummary` 返回总结文案
- [ ] AI 总结失败时降级为基础统计文案（今日时长 + 番茄数）
- [ ] `aiClient` 在 30 秒超时 / 401 / 429 等错误时均有兜底
- [ ] 凭据**仅在云函数环境变量**，前端源码 grep 不到 `CODING_PLAN_API_KEY`（**安全验收**）

## Phase 7 · 管理后台与统计

- [ ] 「我的 → 管理统计」入口对所有登录用户可见
- [ ] 非 admin 用户进入管理统计页显示「无管理员权限」+ 返回首页按钮
- [ ] admin 用户进入管理统计页自动加载 `adminStats`
- [ ] 总预约 / 已签到 / 爽约率 / 当前占用（含暂离中）四宫格数据正确
- [ ] 状态分布图（条形 + 图例）颜色与状态对应（含 `paused` 暂离中）
- [ ] adminStats 云函数在未配置 `ADMIN_OPENID_HASHES` 时返回 `ADMIN_NOT_CONFIGURED`
- [ ] adminStats 云函数在非白名单用户调用时返回 `FORBIDDEN`
- [ ] 前端收到 `FORBIDDEN` / `ADMIN_NOT_CONFIGURED` 自动降级为未授权态
- [ ] 刷新按钮可重新拉取统计
- [ ] 「空态」在没有数据时显示「暂无统计数据」提示

## Phase 8 · 交付与文档

- [ ] `.env.example` 包含 `ADMIN_OPENID_HASHES` + 哈希生成方法说明
- [ ] `README.md` 项目状态表反映 Phase 1~8 实际进展
- [ ] `docs/DEPLOY.md` 包含云函数上传顺序、数据库索引、环境变量配置
- [ ] `docs/test-cases.md`（本文档）覆盖所有 Phase
- [ ] `project.config.json` `packOptions.ignore` 排除 node_modules / docs / scripts / `.env` / 源码映射 / 测试报告
- [ ] `.gitignore` 排除 `node_modules`、`.env.*`、临时备份、`*.bak`

---

## 安全验收（贯穿所有 Phase）

- [ ] 全仓 grep 不到明文 `openid` 字符串（仅哈希形式）
- [ ] 全仓 grep 不到真实 `CODING_PLAN_API_KEY` 值（仅字段名）
- [ ] 全仓 grep 不到 `wxfc0e04dee08cc17d` 以外的 `appid` 字符串
- [ ] 所有云函数对 `event.payload` 进行类型校验（避免 NoSQL 注入）
- [ ] 所有云函数失败时仅返回 `code + message`，不泄漏堆栈

---

## 自动化测试

> 已实现：`npm run test:cloud`（`scripts/cloud-logic.test.cjs`，内存 mock 数据库驱动真实云函数逻辑，**84 例**）。
> 未实现（仍需云环境/真机，供后续 Phase 推进）：

- [ ] E2E：预约 → 签到 → 暂离 → 学习的完整闭环（需真机 + 云端）
- [ ] 性能测试：adminStats 在 10 万条 records 下响应 < 2s（需云端）

当前已实现自动化：

- ✅ `npm run typecheck`（TypeScript）
- ✅ `npm run lint`（ESLint）
- ✅ `npm run seed:check`（种子数据完整性）
- ✅ `npm run test:cloud`（84 例：leaveSeat 7 / expireRecords 11（含 >100 条分页）/ studyRecord 计算+状态机+summary 分页+list 分页 25 / createReservation 冲突 7 / adminStats 鉴权+口径 15 / checkin 时间窗+扫码规范化 10 / validator 9）
- ⚠️ `npm run format:check`（45 个文件格式警告，待处理）