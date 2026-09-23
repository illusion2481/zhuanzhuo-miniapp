# 云函数接口说明（Phase 2 起逐步完善）

统一返回：

```json
{
  "success": true,
  "data": {},
  "message": "操作成功",
  "request_id": "req_xxx"
}
```

| 云函数 | 阶段 | 说明 |
|---|---|---|
| login | 2 | 登录与用户初始化（users 集合 upsert） |
| categoryList | 2 | 分类查询（支持 type / status） |
| seedData | 2 | 写入 categories 与演示 records |
| roomList | 3 | 自习室与座位状态 |
| createReservation | 4 | 创建预约 |
| cancelReservation | 4 | 取消预约 |
| checkin | 4 | 签到 |
| leaveSeat | 5 | 暂离/返回（占位，待实现） |
| expireRecords | 4/5 | 超时释放 |
| studyRecord | 5 | 学习记录（占位，待实现） |
| aiRecommend | 6 | AI 座位推荐（占位，待实现） |
| aiSummary | 6 | AI 学习总结（占位，待实现） |
| adminStats | 7 | 管理统计（已实现，见下） |

## adminStats（Phase 7，已实现）

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

前端统计通过 `pages/admin/admin` 展示（需登录后手动进入，admin 身份由 `ADMIN_OPENID_HASHES` 控制）。

---

## checkin（Phase 4，已实装到店签到码）

`main(event)`：`{ record_id, seat_code?, checkin_code? }`

凭证校验优先级：

1. **`checkin_code`**：到店签到码。命中该房间的「固定码」或「当日动态码」（凌晨 2 点前额外容忍前一天）→ `payload.checkin_method = 'code'`
2. **`seat_code`**：扫到的座位二维码内容，规范化后必须与预约座位一致 → `'scan'`
3. **两者都没有**：仅当云函数环境变量 `CHECKIN_REQUIRE_CODE=0` 时放行（`'manual'`），否则返回
   `{ success:false, code:'NEED_CHECKIN_CODE', data:{ need_code:true }, message:'请到店后输入店内签到码完成签到' }`

签到码派生（确定性、无需落库）：
`code = pad4( parseInt( HMAC-SHA256(secret, `${roomId}|${北京时间YYYY-MM-DD}`).slice(0,8), 16 ) % 10000 )`
`secret = process.env.CHECKIN_CODE_SECRET || 'zz-focusseat-checkin-v1'`

## adminOps（Phase 7+，action 分发）

外层 `action` 分发，具体动作参数名统一用 `op`（避免同名覆盖）。已支持：

| action | 入参 | 说明 |
|---|---|---|
| overview | — | 经营看板（实时占用 / 今日与近 7 日 / 高峰时段） |
| listReservations | `status`、`date`(`today`/`all`/`YYYY-MM-DD`)、`room_id` | 预约订单列表 |
| reservationAction | `record_id`、`op`(`cancel`/`no_show`/`checkin`/`complete`) | 单条预约处置 |
| listUsers | `keyword` | 用户列表（违规次数 / 禁约状态） |
| userAction | `user_id`、`op`(`clear_penalty`/`ban`/`unban`) | 用户信用 |
| upsertRoom | `room_id?`、`name`、`building`、`floor`、`open_time`、`close_time`、`code?` | 新增/编辑自习室 |
| setRoomStatus | `room_id`、`status`(`active`/`disabled`) | 启停自习室 |
| addSeats | `room_id`、`prefix`、`count`、`features?` | 批量新增座位 |
| batchSeatStatus | `room_id`、`seat_ids`、`status`(`maintain`/`free`) | 批量维护/释放 |
| **checkinCodes** | — | 各房间当前生效签到码 `{ rooms:[{room_id,name,custom,code,date}], date, require_code }` |
| **setCheckinCode** | `room_id`、`code`（4-8 位数字/字母，空串 = 恢复每日自动） | 设置/清除固定签到码 |

鉴权两级（任一通过）：环境变量 `ADMIN_OPENID_HASHES` ∈ {sha256(openid).slice(0,32)}，或 `users/<hash>.role === 'admin'`。

## notify（订阅消息推送，上线建议项）

`main(event)`：`{ action:'send', openid?, templateId?, page?, data? }`

- `templateId`：优先用入参，缺省读环境变量 `TPL_RESERVATION_CONFIRMED`
- `touser`：`event.openid` 或云函数 `cloud.getWXContext().OPENID`
- 未配置模板返回 `{ success:false, code:'NO_TEMPLATE' }`；发送失败返回 `{ success:false, code:'SEND_FAIL' }`
- 仅供 `services/notify.ts` 在预约成功后调用，`wx.requestSubscribeMessage` 授权前置

前端入口：`pages/reservation/reservation.ts` 成功分支 → `services/notify.ts → notifyReservationConfirmed(record)`
