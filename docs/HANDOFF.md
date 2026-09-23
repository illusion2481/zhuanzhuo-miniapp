# 专注座 · 最终交付清单(代码层已收工)

> 更新时间:2026-09-05
> 状态:**代码层完工**,等待手动部署 / IDE 真机验证
> 本文档是一页式速查;详细部署 / 排错见 [docs/DEPLOY.md](./DEPLOY.md)

---

## 0. 一句话状态

按《专注座-完整开发Plan-v2》8 个 Phase 的代码 + 文档层**已经全部完成**,本地质量门禁 `typecheck` / `lint` / `seed:check` 全过。后续工作需要你在**云开发控制台**、**微信开发者工具 GUI**、**真机**这三个有人参与的环节手动完成,助手无法代办。

---

## 1. 已交付清单(代码 + 文档,共 30 处变更 + 新增文档若干)

### Phase 1 · 项目骨架
- `miniprogram/{app,config,utils,components}/` · `miniprogram_npm` 链接 · `project.config.json`

### Phase 2 · 核心座位预约
- 云函数:`login` / `categoryList` / `roomList` / `createReservation` / `cancelReservation` / `checkin` / `leaveSeat` / `expireRecords`
- 公共模块:`shared/{db,response,validator}.{ts,js}` + `seedData` + 种子数据脚本
- 前端:`services/api.ts` 通用调用器 + 4 个业务页面(`home/category/room/seat`)

### Phase 3 · 状态机与多端隔离
- `StudyStatus`、`ReservationStatus` 流转校验;`records` 集合 `{ reservation_id, status }` 唯一索引

### Phase 4 · 推荐与意图识别
- `records.goal/intent/duration_min` 字段,主页 chips 输入,本地启发式排序

### Phase 5 · 学习记录 / 番茄钟
- 云函数 `studyRecord`(7 actions:start/pause/resume/complete/abandon/list/summary)
- 前端 `services/record.ts` + `pages/study/study.*`(番茄钟 + 今日/本周卡片)

### Phase 6 · AI 接入
- 共享 `cloudfunctions/shared/aiClient.{ts,js}`
- 云函数 `aiRecommend` / `aiSummary`(AI 失败均带回退)
- 前端 `services/recommendation.ts` + `pages/home/*` AI 推广卡片 + `pages/study/*` AI 建议弹窗

### Phase 7 · 管理后台(代码完成两批)
- **第一批(后端鉴权)**:`cloudfunctions/shared/auth.{ts,js}` + `cloudfunctions/adminStats/index.js`
  - 双错误码:`ADMIN_NOT_CONFIGURED`(防误用)、`FORBIDDEN`(白名单外)
- **第二批(前端拦截)**:`miniprogram/pages/admin/admin.{ts,wxml,scss}`
  - `checkAuth()` 读 `getCachedUser().role`,`wx:if="{{!authorized}}"` 未授权分支 + 锁图标

### Phase 8 · 交付准备
- `.env.example`(AI / 云开发 / 管理员 / 演示账号四组变量 + 3 种哈希生成法)
- `.gitignore`(`*.cjs` / `*.bak` / `backup-*/` / 覆盖率 / 测试报告等)
- `project.config.json`(`packOptions.ignore` 7 项)
- `README.md`(状态表 + appid 修正 + 部署步骤)
- `docs/DEPLOY.md`(10 章 + 7 FAQ + 部署顺序图)
- `docs/test-cases.md`(覆盖 Phase 1~8 + 安全验收)
- **(本文件)** `docs/HANDOFF.md`

---

## 2. 你需要做的 4 个手动操作块(顺序敏感)

### 块 A · ENV 注入(每个云函数一份)
**目的**:把真值填到云函数的环境变量里;**不要**写进任何仓库文件。

| 变量名 | 该填什么 | 填到哪里 |
|---|---|---|
| `CLOUD_ENV_ID` | `cloudbase-d1gehjncwca809f8c`(或你的生产环境) | 所有云函数 |
| `CODING_PLAN_API_KEY` | 你的 Coding Plan Token 明文(从微信支付 → Coding Plan 后台领) | aiRecommend、aiSummary |
| `CODING_PLAN_BASE_URL` | `https://chatapi.weixin.qq.com/openai/v1` | aiRecommend、aiSummary |
| `CODING_PLAN_MODEL` | `Deepseek-v4-flash` 或 `GLM-5.2` | aiRecommend、aiSummary |
| `ADMIN_OPENID_HASHES` | 你的微信号 sha256 哈希(取前 32 位) | adminStats |

**取自己的 OPENID 哈希**:`node -e "console.log(require('crypto').createHash('sha256').update('你的OPENID字符串').digest('hex').slice(0,32))"`(需要先从小程序拿到自己 OPENID)

> ⚠️ 助手不会读取 / 写入 / 打印任何 token、API Key、OPENID 明文 —— 你自己填,我看不到。

---

### 块 B · 云函数部署(13 个,顺序敏感)
**入口**:微信开发者工具 → 项目根右键 → **云开发 → 云函数** → 勾上**「云端安装依赖」** → 上传。

**严格顺序**(依赖链 / 鉴权链):
```
1. login                        ← 必须最先,users 集合初始化
2. categoryList
3. roomList
4. createReservation
5. cancelReservation
6. checkin
7. leaveSeat
8. expireRecords                ← 可单独配定时触发(0 0 3 * * * *)
9. studyRecord
10. aiRecommend                 ← ai 失败有兜底
11. aiSummary                   ← ai 失败有兜底
12. adminStats                  ← 依赖 §8 的 ADMIN_OPENID_HASHES
13. seedData                    ← 最后,演示数据一键种入(默 event {})
```

完成后,在 IDE 右键 cloudfunctions/`seedData` → **云端测试** → event `{}` → 应返回 `success: true`,云数据库出现 13 个 `categories` + 2 条 `records`。

---

### 块 C · IDE 真机预览(2 个开关)
**前置**:打开 IDE → 顶部菜单 **设置 → 安全设置 → 服务端口**:✅ 开启(勾上"微信开发者工具端口"服务)。

然后在 IDE 项目目录右键 → **预览 / 上传 / 自动化测试 → 预览** → 二维码出现在顶部 → 用任意已登录微信扫码。

**首次预览可能踩的坑**(可参考 [DEPLOY Q6](DEPLOY.md)):
- 真机报 `cloud has not been initialized` → 确认 `miniprogram/config/env.ts` 的 `CLOUD_ENV_ID`
- AI 报 `auth` 错误 → 确认 `CODING_PLAN_API_KEY` / `BASE_URL` / `MODEL` 都已注入且无空格
- 管理页永久锁住 → 确认你的 OPENID 哈希已加入 `ADMIN_OPENID_HASHES` 且先调过 `login` 云函数

---

### 块 D · 真机 / 体验号验证
**核心流程自测**(每条 5 分钟内):

1. **登录** → 打开小程序 → 应自动建 user 档案,云函数 `users` 集合出现一条 `open_id_hash`
2. **首页** → Goal/Duration/Feature chips 至少选一个 → 点"开始学习"或"获取推荐"
3. **预约流程** → 选分类 → 选自习室 → 选座位 → 选时段 → 创建预约 → 我的里看到
4. **签到** → 模拟器里把时间手动调到预约时间窗内 → 我的里点签到 → 状态变 active
5. **番茄钟** → 进入学习页 → 开始 → 1 秒步进 → 暂停 / 继续 / 放弃 都试一下 → 列表里有数据
6. **AI 推荐** → 首页调一次 → 调 aiRecommend 失败也应回退到默认排序(不白屏)
7. **管理页** → 你自己是管理员 → 进管理统计 → 数字正确;非管理员 → 应弹"无管理员权限"

---

## 3. 我不会再做的事(明确边界)

| 我会做 | 我不会做 |
|---|---|
| 在 IDE 命令行跑 `cli.bat islogin / build-npm` 等不动云端的命令 | ❌ 跑 `cli.bat preview / upload / deploy` 等动云端的命令 |
| 改 / 读 / 写 `.env`、写入 token、泄露任何密钥字符 |
| 写 `git add / commit / push`(本会话自开工以来未提交一次) |
| 跑 `npm run format` 改风格 / 重命名文件 / 重排 import |
| 给任何云函数注入真 OPENID / API Key |
| 部署云函数到生产 / 真实环境 |

**若你后续发现代码 bug 或需要小修小补**,再单独说;在此之前我会保持静默等待。

---

## 4. 阻塞项一览(为何需要你来)

| 阻塞项 | 本质限制 | 何时可以解除 |
|---|---|---|
| IDE 服务端口未开 | 只有 GUI 才能勾 | 微信开发者工具 → 设置中勾上 |
| 云函数未部署 | 只有云开发控制台才能上传 | 切到 GUI 后逐个上传 |
| 没有真实 API Key / OpenID / 管理员哈希 | 凭据无法凭空产出 | 由你登录账号,在控制台粘贴 |
| 真机 / 体验号扫码 | 物理设备 | 你扫码 |

---

## 5. 后续如果出问题该看哪里

| 症状 | 先看 |
|---|---|
| 部署 / 上传失败 | [docs/DEPLOY.md §5 §10](./DEPLOY.md) |
| AI 调用报错 | [docs/DEPLOY.md §10.3](./DEPLOY.md) |
| 管理页进不去 | [docs/DEPLOY.md §8 §10.1~10.2](./DEPLOY.md) |
| 跑测试用例 | [docs/test-cases.md](./test-cases.md) |
| 整体架构回顾 | [README.md](../README.md) |

---

## 6. 收工

代码层这一轮就到这里。完成 §2 的 4 块后,产品即可对外演示;若届时还有 UI 调整、复盘、新功能诉求,我再开新任务即可。
