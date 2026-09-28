# 云函数接口说明

> 本文档为专注座小程序全部云函数接口的权威说明。接口形态为**云函数即接口**：前端无任何直连服务器地址，所有业务调用均通过 `wx.cloud.callFunction` 完成，因此本文档即本项目的「API 文档」。

统一返回：

```json
{
  "success": true,
  "data": {},
  "message": "操作成功",
  "code": "OK",
  "request_id": "req_xxx"
}
```

- `success`：业务是否成功；`false` 时 `code` 携带业务错误码（如 `SEAT_CONFLICT`），`message` 为用户可读文案
- `request_id`：每次调用唯一，便于链路排查
- 前端统一经 `miniprogram/services/cloud.ts` 的 `callCloudApi` 调用，负责错误归一化与业务错误码透传

## 一、接口清单（22 个）

| # | 云函数 | 职责 | 关键入参 |
|---|---|---|---|
| 1 | login | 登录与用户初始化（users 集合 upsert，只存 open_id_hash） | code |
| 2 | categoryList | 分类与房间列表 | type?, status? |
| 3 | roomList | 自习室与座位实时状态（图视角） | room_id?, date? |
| 4 | createReservation | 创建预约（冲突检测 + 开放时段夹取） | room_id, seat_id, start_at, end_at |
| 5 | cancelReservation | 取消预约 | record_id |
| 6 | checkin | 签到（扫码 / 动态码 / 固定码三档核验） | record_id, seat_code?, checkin_code? |
| 7 | leaveSeat | 暂离 / 返回（限时 30 分钟，超过自动释放） | record_id, action |
| 8 | expireRecords | 违约结算定时任务（每日 03:00）🔔 | — |
| 9 | studyRecord | 学习记录 / 番茄统计 / 目标与小结 | record_id?, action |
| 10 | studyRank | 专注排行榜与统计 | period |
| 11 | submitFeedback | 提交反馈 | content, category_id? |
| 12 | submitReview | 提交评价 | target_type, target_id, rating, content |
| 13 | updateReservation | 预约改期 / 状态更新 | record_id, patch |
| 14 | useCredit | 积分抵免违约（1 积分抵 1 次，上限 10） | no_show_id |
| 15 | notify | 订阅消息下发（预约确认等） | action:'send', openid?, templateId?, data? |
| 16 | aiChat | AI 即时答疑（多轮） | prompt, session_id? |
| 17 | aiRecommend | AI 学习前建议（时段 / 座位 / 计划） | user_id?, history |
| 18 | aiSummary | AI 学习总结（按周期） | period |
| 19 | adminStats | 经营看板统计 | start_at?, end_at? |
| 20 | adminOps | 后台动作分发（订单 / 用户 / 座位 / 签到码） | action, op, ... |
| 21 | adminSeatMaintain | 座位维护 | room_id, seat_ids, action |
| 22 | seedData | 初始化字典与演示数据 | includeDemoRecords? |

🔍 `expireRecords` 同时由登录时惰性结算兜底，保证定时任务未触发时违约也不漏。

## 二、典型接口详述

### 2.1 登录 / adminStats（Phase 7，已实现）

`main(event)`：事件可选 `{ start_at?, end_at? }`，按 `records.created_at` 过滤。返回：

```json
{
  "success": true,
  "data": {
    "total": 34,
    "byStatus": { "pending_checkin": 3, "active": 2, "completed": 18, "cancelled": 4, "no_show": 7 },
    "checkedIn": 20,
    "finished": 29,
    "totalSeats": 26,
    "occupiedNow": 2,
    "rates": { "noShowRate": 14.3, "checkInRate": 58.8, "completionRate": 100, "occupancyRate": 7.7 }
  }
}
```

### 2.2 checkin（已实装到店签到码）

`main(event)`：`{ record_id, seat_code?, checkin_code? }`

凭证校验优先级：

1. **`checkin_code`**：到店签到码。命中房间「固定码」或「当日动态码」（凌晨 2 点前额外容忍前一天）→ `payload.checkin_method = 'code'`
2. **`seat_code`**：扫到的座位二维码内容，规范化后必须与预约座位一致 → `'scan'`
3. **两者都没有**：仅当环境变量 `CHECKIN_REQUIRE_CODE=0` 时放行（`'manual'`），否则返回
   `{ success:false, code:'NEED_CHECKIN_CODE', data:{ need_code:true }, message:'请到店后输入店内签到码完成签到' }`

签到码派生（确定性、无需落库）：

```
code = pad4( parseInt( HMAC-SHA256(secret, `${roomId}|${北京时间YYYY-MM-DD}`).slice(0,8), 16 ) % 10000 )
secret = process.env.CHECKIN_CODE_SECRET || 'zz-focusseat-checkin-v1'
```

### 2.3 adminOps（后台动作分发）

> 外层按 `action` 分发，具体动作参数名统一用 `op`（避免同名覆盖）。

| action | 入参 | 说明 |
|---|---|---|
| overview | — | 经营看板（实时占用/今日与近 7 日/高峰时段） |
| listReservations | `status`、`date`(`today`/`all`/`YYYY-MM-DD`)、`room_id` | 预约订单列表 |
| reservationAction | `record_id`、`op`(`cancel`/`no_show`/`checkin`/`complete`) | 单条预约处置 |
| listUsers | `keyword` | 用户列表（违规次数 / 禁约状态） |
| userAction | `user_id`、`op`(`clear_penalty`/`ban`/`unban`) | 用户信用 |
| upsertRoom | `room_id?`、`name`、`building`、`floor`、`open_time`、`close_time`、`code?` | 新增/编辑自习室 |
| setRoomStatus | `room_id`、`status`(`active`/`disabled`) | 启停自习室 |
| addSeats | `room_id`、`prefix`、`count`、`features?` | 批量新增座位 |
| batchSeatStatus | `room_id`、`seat_ids`、`status`(`maintain`/`free`) | 批量维护/释放 |
| checkinCodes | — | 各房间当前生效签到码 |
| setCheckinCode | `room_id`、`code`（4-8 位数字/字母，空串=恢复每日自动） | 设置/清除固定签到码 |

鉴权两级（任一通过）：环境变量 `ADMIN_OPENID_HASHES` ∈ {sha256(openid).slice(0,32)}，或 `users/<hash>.role === 'admin'`。

### 2.4 notify（订阅消息推送）

`main(event)`：`{ action:'send', openid?, templateId?, page?, data? }`

- `templateId`：优先用入参，缺省读环境变量 `TPL_RESERVATION_CONFIRMED`
- `touser`：`event.openid` 或云函数 `cloud.getWXContext().OPENID`
- 未配置模板返回 `{ success:false, code:'NO_TEMPLATE' }`；发送失败返回 `{ success:false, code:'SEND_FAIL' }`
- 前端入口：`subpages/services/notify.ts → notifyReservationConfirmed(record)`，`wx.requestSubscribeMessage` 授权前置

## 三、接口维护规范

> 本节约束所有云函数接口的演进，防止「代码改了、文档脱节、调用方踩坑」。

### 3.1 加一个接口 = 加一个云函数

云函数的**签名（入参 / 返回 / 错误码）天然就是对外接口**。任何新增业务能力都按「新建云函数 + 在本文档补一条 + 前端 services 加一个调用方法」三步推进，禁止在旧函数里塞 `if (type === 'new')` 式的分支膨胀。

### 3.2 新增 / 变更接口必须同步本文档

- 新增云函数 → 在「一、接口清单」追加一行；
- 改返回结构或错误码 → 更新对应「二、详述」段落（不单独建文件）；
- 声明 `success:false` 时必须携带**语义化 `code`**（如 `NEED_CHECKIN_CODE`），前端据此分支，不解析 message 文本；
- 变更后跑 `cloud-logic.test.cjs`（409 项断言）确认不破坏既有契约。

### 3.3 入参规则

- 全部通过 `event` 传参，参数名统一 snake_case（如 `start_at`、`record_id`）；
- 可选参数用 `?` 标注；必填参数缺失时返回 `{ success:false, code:'MISSING_PARAM', message:'缺少参数 xxx' }`；
- 用 `shared/validator.ts` 做参数白名单校验，防注敏感字段（如前端不可传 `role`）。

### 3.4 统一返回协议（shared/response）

- 成功使用 `ok(data, message)`，失败使用 `fail(message, code, data)`;
- 返回必须带 `success` 与 `request_id`，前端 `callCloudApi` 依赖它做错误归一化。

### 3.5 复用共享层，不复制逻辑

- 鉴权、错误码映射、签名、DB 访问集中在 `cloudfunctions/shared/`；
- **新增云函数必须复用 shared，禁止从别的函数复制粘贴逻辑**（体检曾发现占位实现，属违规复用）。

### 3.6 兼容性优先

- 只能**加字段，不能删改已有字段语义**；废弃的返回字段保留并标注 `deprecated`；
- 前端需跟着 `services/*.ts` 的调用方同步演进，禁止直接调 `wx.cloud.callFunction` 绕过封装。

## 四、前端调用入口（services）

| 模块 | 职责 |
|---|---|
| `services/cloud.ts` | `callCloudApi`：统一封装调用、错误归一化、业务错误码透传 |
| `services/auth.ts` | 登录、资料完善判断 |
| `services/room.ts` | 自习室/座位/预约 |
| `services/credit.ts` | 积分、抵免、邀请 |
| `subpages/services/notify.ts` | 订阅消息发送 |
| `services/statistics.ts` | 学习统计/排行榜 |
| `services/recommendation.ts` | AI 推荐 |
| `services/admin.ts` | 后台管理动作 |

前端所有接口调用都走 `callCloudApi`，新增页面调用时**复用对应 services 模块**，避免散落裸调用。