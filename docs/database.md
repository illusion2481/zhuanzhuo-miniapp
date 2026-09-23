# 数据库说明

## 集合

| 集合 | 用途 |
|---|---|
| `categories` | 自习室、座位属性、学习目标、反馈标签字典；自习室座位平面存在 `metadata.seats` |
| `records` | 预约 / 签到 / 暂离 / 学习 / 反馈业务事件（只追加状态流转，不物理删除） |
| `users` | 用户档案（仅存 openId 哈希，不含明文 openId） |

## 初始化

1. 在云开发控制台创建上述三个集合（可为空）。
2. 上传并部署云函数 `seedData`、`login`、`categoryList`。
3. 云函数测试调用 `seedData`（可选参数）：

```json
{
  "includeDemoRecords": true,
  "resetCategories": false,
  "resetRecords": false
}
```

4. 本地也可运行摘要校验：

```bash
npx tsx scripts/seedCategories.ts
npx tsx scripts/seedDemoData.ts
```

## 建议索引

- `categories`: type + status + sort
- `records`: user_id + record_type + created_at
- `records`: room_id + seat_id + start_at + end_at
- `records`: record_type + status + start_at
- `users`: open_id_hash

## 业务规则摘要

- 预约冲突由云函数校验（Phase 4）
- 预约后 15 分钟未签到 → `no_show`
- 暂离最长 30 分钟，超时释放
- 取消 / 签到 / 释放走状态流转，保留历史
