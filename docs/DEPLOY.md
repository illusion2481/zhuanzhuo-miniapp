# 部署与运维手册

> 本手册面向开发者与运维人员，覆盖从零部署到日常排错的完整流程。

---

## 目录

1. [前置条件](#1-前置条件)
2. [本地准备](#2-本地准备)
3. [云开发环境创建](#3-云开发环境创建)
4. [环境变量配置](#4-环境变量配置)
5. [云函数上传顺序](#5-云函数上传顺序)
6. [数据库集合初始化](#6-数据库集合初始化)
7. [演示数据 seeding](#7-演示数据-seeding)
8. [管理员白名单配置](#8-管理员白名单配置)
9. [体验号加入白名单](#9-体验号加入白名单)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 前置条件

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | >= 18 | 本地运行 npm 脚本 |
| 微信开发者工具 | 最新稳定版 | [下载地址](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) |
| 小程序 AppID | 已申请的真实 AppID（非测试号） | 用于上传体验版 |
| 微信云开发 | 已开通且创建至少一个环境 | [开通文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html) |
| Coding Plan API Key | 已领取 Coding Plan Token | 用于 AI 推荐/总结功能 |

---

## 2. 本地准备

```bash
# 1. 克隆项目（如果还没有）
git clone <repository-url> zhuanzhuo-miniapp
cd zhuanzhuo-miniapp

# 2. 安装依赖
npm install

# 3. 复制环境变量模板
cp .env.example .env
# ⚠️ .env 已被 .gitignore 忽略

# 4. 在微信开发者工具中打开本目录
#    - 顶部菜单 → 工具 → 构建 npm
#    - 会生成 miniprogram/miniprogram_npm 目录（也在 .gitignore 中）
```

**验证本地代码健康度**（不依赖 IDE / 云开发）：

```bash
npm run typecheck      # TypeScript 类型检查
npm run lint           # ESLint
npm run seed:check     # 种子数据完整性
```

全部应为 0 错误 0 警告。

---

## 3. 云开发环境创建

1. 微信开发者工具 → 顶部 **云开发** 按钮
2. 同意服务协议 → 创建新环境（建议命名为 `prod` / `dev`）
3. 等待环境创建完成（通常 1~2 分钟）
4. 复制 **环境 ID**（形如 `cloudbase-xxxxxxxxxxxx`）
5. 将环境 ID 写入 `miniprogram/config/env.ts`：

   ```ts
   export const CLOUD_ENV_ID = '你的环境_ID';
   ```

   ⚠️ 此步骤已在本项目默认配置中完成（开发用环境），生产部署需替换为正式环境 ID。

---

## 4. 环境变量配置

在云开发控制台 → **云函数** → 选中具体函数 → **配置** → **环境变量** 注入以下变量。

### 4.1 公共变量（注意：不存在「全局变量」，每个云函数都要单独配）

| 变量名 | 必填 | 说明 |
|---|---|---|
| `CLOUD_ENV_ID` | 推荐 | 与前端保持一致的环境 ID |

> ⚠️ 微信云开发的**环境变量按云函数隔离**，没有「配一次全体生效」的全局变量。
> 新增云函数**不会继承**任何已有函数的环境变量 —— 本项目的 `aiChat` 就是新增函数，
> 必须**单独**再配一遍 `CODING_PLAN_API_KEY`（它的表现见 4.2 节）。

### 4.2 AI 能力相关（aiRecommend / aiSummary / **aiChat** —— 三个都要配）

| 变量名 | 必填 | 说明 |
|---|---|---|
| `CODING_PLAN_API_KEY` | ✅ 必填 | 从 [Coding Plan 后台](https://chatapi.weixin.qq.com) 领取的 Token（**你的凭据在这里**） |
| `CODING_PLAN_BASE_URL` | 默认即可 | **接口地址（网关域名），不是 Token**；留空即用代码里的默认值 |
| `CODING_PLAN_MODEL` | 默认即可 | 推荐 `Deepseek-v4-flash` 或 `GLM-5.2` |

> 🧭 **别把 BASE_URL 当成「放 Token 的地方」**（这是最常被误解的一点）：
>
> | 变量 | 角色 | 类比 |
> |---|---|---|
> | `CODING_PLAN_API_KEY` | 你的 Token / 密钥 | 门禁卡 |
> | `CODING_PLAN_BASE_URL` | 请求发往哪个网址 | 门牌地址 |
>
> 两个变量承担的是**完全不同**的事。删掉 `CODING_PLAN_BASE_URL` 不影响 Token ——
> `shared/aiClient.js` 里写着 `process.env.CODING_PLAN_BASE_URL || DEFAULT_BASE_URL`，
> 留空就用默认网关 `https://chatapi.weixin.qq.com/openai/v1`。
>
> ⚠️ **手填 `BASE_URL` 最致命的坑：多写了 `/chat/completions`。**
> `shared/aiClient.js` 的 `requestOnce` 会在 baseUrl **后面再拼一次** `/chat/completions`
> （代码第 194 行：`fetchImpl(\`${baseUrl}/chat/completions\`, ...)`）。
> 所以：
> - 填 `…/openai/v1` → 实际请求 `…/openai/v1/chat/completions` ✅ 正确
> - 填 `…/openai/v1/chat/completions`（即完整 endpoint）→ 实际请求 `…/openai/v1/chat/completions/chat/completions` ❌ **HTTP 404 `{"detail":"Not Found"}`**
>
> 因此：**`CODING_PLAN_BASE_URL` 只填到 `/openai/v1` 为止，或直接留空用默认值。**
> 2026-09-22 真实日志踩中过这坑：`AI_HTTP_404 … | {"detail":"Not Found"}`，根因就是 BASE_URL 带了 `/chat/completions`。
>
> 也就是说 `/openai/v1` 之后写什么网关都不校验；**唯一红线是地址里必须包含 `/openai/v1`**。
> 推荐留空用默认值（最省心），要填就填 `https://chatapi.weixin.qq.com/openai/v1`。

> ⚠️ **需要配置的函数一共三个**：`aiRecommend`（AI 选座 / 学习计划 / 课程推荐）、
> `aiSummary`（学习总结）、`aiChat`（AI 客服）。
> **漏配 `aiChat` 的表现**：AI 客服页一切正常，但每次提问都回
> 「AI 客服正在配置中」或「AI 助手暂时走神了」，并弹出「转人工客服」按钮 ——
> 极易被误判成网络问题。定位方法：云函数日志里搜 `AI_NOT_CONFIGURED`。

**`aiRecommend` 支持三个 action**（前端按需调用，模型降级全部自动）：

| action | 用途 | 前端入口 |
|---|---|---|
| `recommend`（默认） | AI 选座推荐 | 首页「AI 帮你选座」 |
| `generate_plan` | AI 学习计划（分段时间轴）；**AI 会把推荐课程写进每个时段的标题与「学习方式」，不再用「热身/保持专注」这类空洞文案** | 首页学习计划输入框 |
| `recommend_courses` | **AI 课程推荐**（弹窗内展示；AI 失败自动降级本地精选）。前端拿到后**随计划请求回传 `courses`**，云端优先复用（不重复消耗限次），未传才云端兜底自取 | 学习计划弹窗「AI 课程推荐」区 |

### 4.2.1 大赛 Token 接入（AI 推荐 / AI 总结）

> **结论：微信小程序开发大赛发放的 Token 走的就是本项目现成的通道，代码一行不用改，只配环境变量。**
>
> 大赛发的不是「云开发额度」，而是 **Coding Plan API Key**：`https://chatapi.weixin.qq.com/openai/v1`（OpenAI 兼容协议），
> 与 `cloudfunctions/*/shared/aiClient.js` 的默认地址完全一致。

**领取（不提交作品也能领）**

1. 大赛报名：<https://contest.weixin.qq.com>（微信扫码登录，填资料即可）
2. 用**同一个微信**登录 Coding Plan 后台 <https://chatapi.weixin.qq.com> → 点「申请 Token」
3. 按报名顺序分批发放，发放后邮件里会有具体使用方法

**配置（`aiRecommend` / `aiSummary` / `aiChat` 三个都要配，漏一个 → 那一项静默降级）**

云开发控制台 → 云函数 → `aiRecommend` → 配置 → 环境变量 → 新增 `CODING_PLAN_API_KEY`；
`aiSummary`、`aiChat` 各按**同样的步骤单独操作一遍**（环境变量按函数隔离，不共享、不继承）。

> ⚠️ **Token 只存在于云控制台的环境变量里**，不要写进代码、文档、`.env` 文件，
> 也不要直接粘贴到聊天/工单里（会留痕）。万一泄露，去后台重置即可，旧 Key 约 5 分钟后失效。

| 变量名 | 填什么 |
|---|---|
| `CODING_PLAN_API_KEY` | ✅ 必填，后台拿到的 Token |
| `CODING_PLAN_BASE_URL` | 留空（默认即 Coding Plan 网关） |
| `CODING_PLAN_MODEL` | 留空（默认 `Deepseek-v4-flash`）；若日志报 400，改填 `GLM-5.2` |

**上云前先自检（30 秒，避免「填了不生效还不知道为什么」）**

项目自带自检脚本。**Key 只在运行时输入，脚本不写入任何文件、输出一律脱敏**：

```powershell
# 方式 1（推荐）：交互输入，不进命令行历史
node scripts/check-ai-key.cjs

# 方式 2：环境变量
$env:CODING_PLAN_API_KEY="你的Token"; node scripts/check-ai-key.cjs
```

它会逐个试探候选模型名并打印结果，最后直接告诉你该填哪个：

```
✅ Deepseek-v4-flash    HTTP 200  ...
结论：Key 可用 ✅  推荐 CODING_PLAN_MODEL = Deepseek-v4-flash
```

报错解读：`HTTP 401/403` = Key 无效或过期；`HTTP 429` = 触发限次；`HTTP 400` = 模型名不被接受（换脚本列出的其它可用模型）；`fetch failed` = 网络或网关地址不对。

> 已知可用的模型名是 **`Deepseek-v4-flash`**（本项目 `aiClient` 的默认值）。
> 网关对大小写敏感，若日志报 400，`aiClient` 会自动回退到 `DeepSeek-V4-Flash` → `GLM-5.2`。

**三条硬约束（违反都会「不报错、只是没有 AI」）**

1. **限次不限量**：约 5 小时 1200 次 / 周 9000 次 / 月 18000 次。
   `aiClient` 已内置 **10 分钟结果缓存**（同一份 prompt 直接复用），但仍要避免每次进页面都实时生成。
   额度耗尽后全部静默降级为基础推荐/基础总结——**不报错，只是标签变成「基础总结」**。
2. **部署必须带 `shared` 目录**：两个 AI 云函数都 `require('./shared/aiClient')` 与 `./shared/validator`。
   右键选「**上传并部署：云端安装依赖（不上传 node_modules）**」——它会**上传目录里全部代码文件（含 `shared/`）**，依赖由云端按 `package.json` 安装。
   ⚠️ 反例：选「所有文件」且本地没装 node_modules → 云端没有 `wx-server-sdk` → 每次调用 `-504002 Cannot find module 'wx-server-sdk'`。
3. **运行时需 Node 18+**：`aiClient` 用全局 `fetch`。低版本运行时要装 `node-fetch`，否则抛 `AI_NO_FETCH`。

**验证是否真的生效**

- 学习页点「生成总结」→ 标签显示 **「AI 总结」** 即生效；显示 **「基础总结」** 说明未生效或已降级
- 云开发控制台 → 云函数 → `aiSummary` → 日志，看错误码：
  `HTTP 401` = Key 错/过期；`HTTP 429` = 触发限次；`HTTP 400` = 模型名不匹配（换 `GLM-5.2`）

**与「小程序成长计划 10 亿 Token」不是一回事**

| | 大赛 Coding Plan Token | 成长计划额度 |
|---|---|---|
| 形态 | API Key | 绑定云开发环境的额度 |
| 调用方式 | 任意 HTTPS（含云函数） | 只能 `wx.cloud.extend.AI`（小程序端 / 云函数 / 云托管） |
| 计费 | **限次**（5h 1200 次） | **限量**（10 亿 Token） |
| 本项目 | ✅ 现成，填 Key 即用 | 需另写代码接入，适合额度不够时扩容 |

### 4.3 管理员鉴权（adminStats 必填）

| 变量名 | 必填 | 说明 |
|---|---|---|
| `ADMIN_OPENID_HASHES` | ✅ 必填 | sha256(openid).slice(0, 32) 列表，多人用英文逗号分隔 |

**生成管理员 OPENID 哈希**：

```bash
# 方法 1：Node.js 一行命令（需要你有 openid 明文）
node -e "console.log(require('crypto').createHash('sha256').update('此处填明文_openid').digest('hex').slice(0,32))"

# 方法 2：登录云开发 → 数据库 → users 集合 → 任意文档的 open_id_hash 字段直接复制

# 方法 3：在线 sha256 工具 → 把结果取前 32 位
```

⚠️ **永远不要把明文 openid 写入仓库 / 文档 / 控制台备注**——只存哈希。

### 4.4 到店签到码（防远程签到，checkin / adminOps）

| 变量名 | 必填 | 说明 |
|---|---|---|
| `CHECKIN_REQUIRE_CODE` | 可选 | **默认开启**。设 `0` 关闭校验（用户可直接点签到，不做到店核验） |
| ~~`CHECKIN_CODE_SECRET`~~ | 已废弃 | **两个函数均已固化为同一内置盐值，不再读取此变量**（环境变量在两函数上配置不一致曾导致管理页展示的码与校验码对不上）。若之前配置过，可删除 |

- 签到凭证优先级：**签到码 > 座位二维码 > （开关关闭时才允许）无凭证**
- 签到码默认**每日 0 点自动轮换**（`HMAC(内置盐值, roomId + 北京日期)` 取 4 位数字）；管理页「签到方式」卡可查看，也可给某房间设 4-8 位**固定码**（`categories.metadata.checkin_code`，便于张贴）
- **管理页展示的当日动态码会落库为 `metadata.checkin_code_today`，checkin 校验时同样接受**——保证「管理页看到的码学生一定输得进」，不受两函数部署版本漂移影响。因此 checkin 与 adminOps 必须**成对重新部署**

### 4.5 签到地理围栏（防拍照远程签到，checkin / adminOps）

> 由来：静态签到码贴在座位上，任何人拍张照就能异地签到，等于没有防作弊。
> 所以围栏是**主防线**，签到码降级为可选的二次验证。

| 变量名 | 必填 | 说明 |
|---|---|---|
| `CHECKIN_GEO_RADIUS` | 可选 | 门店未单独配置时的默认半径，**默认 200 米**（夹取范围 20~2000） |
| `CHECKIN_GEO_MAX_ACCURACY` | 可选 | 定位精度上限，**默认 500 米**；超过则拒绝本次签到（多为纯基站定位，不可信） |

配置入口：小程序「管理后台」→ **座位** tab → 卡片「**签到方式**」（2026-09-19 由原「到店签到码」「位置签到」两张卡合并）→ ① 位置签到：选房间 →「地图选点」→ 填半径 → 保存并开启；② 到店签到码（可选二次验证）：设固定码或关闭。两项独立开关，校验顺序固定为「先位置、后签到码」。

落库位置：`categories.metadata.geo = { lat, lng, radius, address, updated_at }`。**只有配了围栏的门店才做位置校验**，未配置的门店行为与升级前完全一致（平滑过渡，不给存量门店制造障碍）。

⚠️ 三条硬约束：

1. **坐标系必须是 gcj02**。`wx.getLocation` 与「地图选点」都是 gcj02，直接配对即可；从高德/百度网页手抄的坐标是 wgs84 / bd09，**直接用会整体偏移数百米**，表现为「人明明站在店里却签不上」。
2. **必须先申请定位接口权限**：mp 后台 → 开发 → 开发管理 → 接口设置 → 申请 `wx.getLocation` / `wx.chooseLocation`；同时在「用户隐私保护指引」里勾选位置信息。未申请时**真机直接报错，而模拟器正常**——遇到「模拟器能签、真机不能签」先查这里。
3. `app.json` 里的 `permission.scope.userLocation` 与 `requiredPrivateInfos` **不要删**，删了定位静默失败。

校验顺序：**围栏 → 签到码**（顺序不可颠倒）。即便签到码正确，人在围栏外依旧拒绝并提示距门店多远（错误码 `GEO_TOO_FAR`）。签到成功后 `records.payload.checkin_geo` 会留痕距离与精度，便于事后处理争议和调参。

---

### 4.6 签退计履约（A2，cancelReservation / login）

- 用户已签到（`active` / `paused`）后主动「签退」→ `cancelReservation` 将状态置为 `completed` 并写入 `users.total_fulfillment` 加 1（`db.command.inc`），返回最新履约数。
- 新建用户初始化 `total_fulfillment: 0`；`login` 返回 `totalFulfillment`，「我的」页展示「累计履约 N 次」。
- 只需重部署 `cancelReservation` + `login` 即可生效；读写都走云函数，无需手动迁移数据。

---

## 5. 云函数上传顺序

⚠️ **顺序很重要**：`login` 必须先于 `adminStats` 上传，否则后者鉴权依赖的前置数据未就绪。

### 5.1 核心业务依赖图

```
login ──→ 初始化 users 集合，提供 role 字段
   ↓
categoryList / roomList ──→ 基础数据读取
   ↓
createReservation / checkin / leaveSeat ──→ 写 records 集合
   ↓
studyRecord ──→ 学习记录（依赖 reservation）
   ↓
aiRecommend / aiSummary ──→ AI 能力（依赖 Coding Plan）
   ↓
adminStats ──→ 管理端统计（依赖 users + records）
   ↓
seedData ──→ 一键种入演示数据（可在任何时候调）
expireRecords ──→ 定时清理（建议配云函数定时触发）
```

### 5.2 推荐上传顺序

在 IDE 中右键每个云函数目录 → **上传并部署：云端安装依赖**：

1. `login`
2. `categoryList`
3. `roomList`
4. `createReservation`
5. `cancelReservation`
6. `checkin`
7. `leaveSeat`
8. `expireRecords`
9. `studyRecord`
10. `aiRecommend`
11. `aiSummary`
12. `adminStats`
13. `aiChat`（**「我的 → 联系客服」的 AI 客服**；目录含 `shared/`，同样用「云端安装依赖」即可，`shared/` 会被一并上传）
14. `seedData`（**最后**，作为数据初始化工具）

每个云函数上传时建议：
- ✅ 统一右键 **「上传并部署：云端安装依赖（不上传 node_modules）」**——本地没装依赖时，选「所有文件」云端不会自动装依赖，必炸 `-504002 Cannot find module 'wx-server-sdk'`
- ❌ 不要勾选「测试覆盖率」（仅本地开发用）

> ⚠️ **AI 类云函数（`aiChat` / `aiRecommend` / `aiSummary`）的超时，必须够「两次尝试」**：
> 云函数**默认超时 3 秒**，而 AI 调用（Deepseek / GLM）单次最坏 9~12 秒。
> `shared/aiClient` 内置了**一次重试**（`retries: 1`，用于挡掉瞬时抖动），
> 所以真正的耗时上限不是「单次超时」，而是 **2 × 单次超时 + 0.5 秒退避**：
>
> | 云函数 | 单次超时（代码内） | 最坏总耗时 | 函数超时（config.json） | 余量 |
> |---|---|---|---|---|
> | `aiChat` | 9s | ≈ 18.5s | **20s** | 约 1.5s（紧但可用）|
> | `aiRecommend` | 12s | ≈ 24.5s | **30s** | 充足 |
> | `aiSummary` | 12s | ≈ 24.5s | **30s** | 充足 |
>
> **顶穿的表现最迷惑**：容器在 20s 被强杀时，**函数里的 `try/catch` 根本来不及执行** ——
> 于是既没有降级文案、也没有半行日志，前端只拿到一个 reject，显示「响应超时」。
> 看起来像「网络问题」，实际是超时配置数学不对。
>
> 三个函数的目录里已加 `config.json`（按上表），**两种「上传并部署」方式都会带上它**；
> 若部署后仍超时，到 云开发控制台 → 云函数 → 对应函数 → 配置 手动改成上表的值
> （**控制台优先级最高，改完即时生效，无需重新部署**）。

### 5.3 增量功能必须重新部署的函数（最易漏）

| 云函数 | 关联功能 | 漏部署时的表现 |
|---|---|---|
| `adminOps` | 后台全部操作、**客服回复 `replyFeedback`**（三态：pending→replied→handled）、签到码 / 围栏配置 | 后台点「发送回复」返回 `UNKNOWN_ACTION` |
| `submitFeedback` | 反馈提交 + **「我的反馈」列表 `listMine`** + **追问 `followUp` / 关闭 `close`** | 「我的反馈」永远为空；追问按钮报 `UNKNOWN_ACTION` |
| `studyRank` | 学习排行榜 | 排行榜空白 |
| `notify` | 订阅消息下发 | 预约/提醒消息收不到 |
| `submitReview` | 座位评价 | 评价提交失败（另需先手动建 `reviews` 集合）|
| `updateReservation` | 改约 / 一键续时 | 续时按钮报错 |
| `adminSeatMaintain` | 座位维护 | 维护状态改不动 |
| `aiChat` | **AI 客服**（「我的 → 联系客服」的默认聊天页；FAQ 知识库 + DeepSeek 智能应答，无人值守也能回） | 聊天页发消息「每问一句都弹『出错了』模态框」= **云函数未部署 / 超时 3s 未调**（见上方 AI 类超时说明）；「一直转圈」= shared/ 没一起上传 |

> **客服闭环必须成对部署**：`adminOps`（写回复）+ `submitFeedback`（读回复 / 追问 / 关闭）。
> 只部署一侧会出现「后台提示回复成功、用户端却看不到回复」或「追问按钮报错」的假闭环。
>
> **「联系客服」现在是两段式**：① `aiChat`（AI 客服，项目内聊天页，24h 秒回常见问题，**必须与 `shared/` 一起上传**）；
> ② 原生微信客服会话（`open-type=contact`）作为 AI 答不上时的**人工兜底**（需在 mp 后台绑定客服人员才会有人回，见
> [`客服配置与运营.md`](./客服配置与运营.md)）。

**反馈工单状态机**（两侧共用，部署后才会生效）：

```
pending（待处理）──后台回复──▶ replied（已回复，等用户确认）
        ▲                          │
        └────── 用户追问 ──────────┤
                                   ▼
                             handled（已关闭：用户点「已解决」/ 后台「不回复直接关闭」）
```

> 后台把「回复过」当成「结束」是常见的体验坑：用户看完回复还有疑问时，
> 追问会把工单打回 `pending` 重新进入待处理列表，管理员请留意「用户追问 N 次」的橙色提示块。

---

## 6. 数据库集合初始化

详见 [docs/database.md](database.md)。简要清单：

| 集合 | 用途 | 关键字段 / 索引 |
|---|---|---|
| `users` | 用户档案 | `open_id_hash` (唯一) |
| `records` | 业务记录（预约 / 学习）| `record_type`, `status`, `created_at` |
| `categories` | 分类（座位属性 / 自习室 / 反馈标签）| `type`, `code` |
| `reviews` | 座位评价（一单一评，文档 `_id` = `rev_<record_id>`）| `record_id`, `room_id`, `seat_id`, `rating` |
| `audit_logs` | 审计日志（可选）| `action`, `operator_hash`, `created_at` |

> ⚠️ `reviews` 集合**必须存在**，否则评价提交会失败（云开发不会在你 `add` 时自动建集合）。
> `submitReview` 已内置自愈：写入失败时会尝试 `db.createCollection('reviews')` 后重试；
> 仍失败会返回「请确认云开发控制台已创建 reviews 集合」。**建议部署前手动建好，别依赖自愈**。
> 该集合同时被 `aiRecommend`（AI 推荐口碑加权）与 `roomList`（选座页「★ 4.8 · 12 条评价」）读取。

### 推荐索引

```javascript
// records 集合（云开发控制台 → 数据库 → 索引管理）
db.collection('records').createIndex({ record_type: 1, created_at: -1 })
db.collection('records').createIndex({ record_type: 1, status: 1 })
db.collection('records').createIndex({ user_id: 1, created_at: -1 })

// categories 集合
db.collection('categories').createIndex({ type: 1, code: 1 }, { unique: true })

// users 集合
db.collection('users').createIndex({ open_id_hash: 1 }, { unique: true })

// reviews 集合：提交评价前按预约查重（一单一评）
db.collection('reviews').createIndex({ record_id: 1 })
```

### 集合权限（控制台建集合时那个「权限类型」下拉框）

**原则：只有前端直连读取的集合才放行，其余一律选最严格的一项。** 云函数以管理员身份访问数据库，**不受**安全规则限制，所以收紧不影响功能。

| 集合 | 权限类型 | 原因 |
|---|---|---|
| `categories` | **所有用户可读**（仅管理端可写） | ⚠️ 选座页 `seats.ts` 用 `wx.cloud.database().collection('categories').doc(roomId).watch()` 做实时座位刷新，**必须**可读；收紧会让实时监听静默降级为 15s 轮询 |
| `reviews` | **仅管理端可读写**（所有用户不可读不可写） | 评价只经 `submitReview` 云函数写入、由 `aiRecommend` / `roomList` 云函数读取，前端从不直连。放行「所有用户可读」= 任何人可批量拉全站评价内容 |
| `records` | **仅管理端可读写** | 含 `user_id`、预约与学习轨迹；前端全部走云函数 |
| `users` | **仅管理端可读写** | 含 `open_id_hash`、信誉/封禁字段 |
| `audit_logs` | **仅管理端可读写** | 审计日志 |

### 安全规则（自定义规则，进阶）

若不用上面的预设下拉框、改用自定义 JSON，最低权限建议：

```json
{
  "read": "doc.user_id == auth.openid || get(`users.${auth.openid}`).role == 'admin'",
  "write": "doc.user_id == auth.openid"
}
```

---

## 7. 演示数据 seeding

### 7.1 通过云函数 seedData

在微信开发者工具 → 云开发 → 云函数 → 选中 `seedData` → **测试**，使用默认 event：

```json
{}
```

返回 `success: true` 表示 13 个分类 + 2 条演示预约已成功种入。

### 7.2 通过本地脚本

```bash
npm run seed:check
```

仅校验种子数据脚本本身的完整性（不写入云端）。写入云端必须通过 `seedData` 云函数。

---

## 8. 管理员白名单配置

### 8.1 准备工作

- 至少 1 个真实微信号（你自己 / 评委 / 测试同事）
- 该微信号已经登录过小程序（调用过 `login` 云函数）→ 会在 `users` 集合中自动创建文档

### 8.2 取哈希

**方法 A**（推荐）：登录云开发控制台 → 数据库 → `users` 集合 → 找到该用户的 `open_id_hash` 字段 → 复制。

**方法 B**：如果用户没登录过，直接对其明文 openid 做 sha256：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('openid 明文').digest('hex').slice(0,32))"
```

### 8.3 写入云函数环境变量

1. 云开发控制台 → 云函数 → 选中 `adminStats`
2. **配置** → **环境变量**
3. 添加 `ADMIN_OPENID_HASHES`，值为上一步的哈希（多人用英文逗号分隔）
4. 保存 → 等待配置生效（5~10 秒）

### 8.4 验证

- 管理员登录小程序 → 进入 **我的** → 身份应显示"管理员"
- 进入 **管理统计** 页面 → 应看到统计数据
- 若仍显示"无管理员权限"，检查：
  1. `ADMIN_OPENID_HASHES` 是否填了**哈希**而非明文 openid
  2. 用户是否调过 `login` 云函数（否则 `users` 集合无文档，role 默认 student）
  3. 当前登录用户与 `users.open_id_hash` 是否一致

---

## 9. 体验号加入白名单

评委 / 测试同事需要扫描二维码进入体验版：

1. **开发侧**：云开发控制台 → 设置 → 成员管理 → 添加体验者（输入对方微信号）
2. **IDE 侧**：右上角 **上传** → 填版本号 → 上传为体验版
3. **二维码**：上传成功后二维码会出现在 IDE 顶部；发送给体验者扫码
4. **体验者侧**：扫码 → 进入小程序 → 第一次会调 `login` 云函数创建用户档案

如需让体验者也是管理员，按 [§8](#8-管理员白名单配置) 把他的 openid 哈希加入 `ADMIN_OPENID_HASHES`。

---

## 10. 常见问题排查

### Q1：调用 adminStats 报 `ADMIN_NOT_CONFIGURED`

**原因**：云函数未配置 `ADMIN_OPENID_HASHES` 环境变量。

**解决**：[§4.3](#43-管理员鉴权adminstats-必填) 配置环境变量并重新部署。

### Q2：调用 adminStats 报 `FORBIDDEN`

**原因**：当前用户的 openid 哈希不在 `ADMIN_OPENID_HASHES` 列表中。

**解决**：
1. 确认 `users` 集合中存在当前用户的文档
2. 取该文档的 `open_id_hash` 字段
3. 加入 `ADMIN_OPENID_HASHES`（用英文逗号分隔）
4. 修改环境变量后**云函数会自动重启**（约 5~10 秒），无需手动重新上传

### Q3：AI 推荐 / 总结 / 客服返回错误

**排查**：
1. 检查 `CODING_PLAN_API_KEY` 是否配置，**且注意是逐个函数配的** ——
   `aiRecommend` 配了不代表 `aiSummary` / `aiChat` 配了
2. 检查 `CODING_PLAN_BASE_URL`：**推荐直接留空**；只有填了值才需要核对是否逐字为
   `https://chatapi.weixin.qq.com/openai/v1`（填错会得到 `HTTP 404`，见 4.2 节说明）
3. 检查 `CODING_PLAN_MODEL` 是否为有效模型名（`Deepseek-v4-flash` / `GLM-5.2`）
4. 查看云函数日志：云开发控制台 → 云函数 → aiRecommend / aiSummary / aiChat → 日志

**AI 客服专项**（症状：每次提问都回「正在配置中」「运行环境缺少组件」或「走神了」+ 转人工按钮）：
1. 云函数日志里找 `[aiChat] AI 调用失败`，紧跟着的错误码即为原因：

   | 错误码 | 含义 | 处置 |
   |---|---|---|
   | `AI_NOT_CONFIGURED` | 没配 Key（最常见） | 给该函数补 `CODING_PLAN_API_KEY` |
   | `AI_NO_FETCH` | 运行时无法发起 HTTPS 请求 | 2026-09-22 起 `shared/aiClient.js` 已内置 http/https 兜底，正常不会再出现；若出现说明部署的 `shared/` 是旧版（未随代码一起上传） |
   | `AI_HTTP_401/403` | Key 失效 / 无权限 | 后台重置 Token |
   | `AI_HTTP_404` | 接口地址不对 | 删掉 `CODING_PLAN_BASE_URL`（用默认值） |
   | `AI_HTTP_429` | 触发限次 | 等额度窗口刷新 |
   | `AI_HTTP_400` | 模型名不被接受 | 改填 `CODING_PLAN_MODEL=GLM-5.2` |

2. 若是 `AI_NOT_CONFIGURED`：控制台 → 云函数 → `aiChat` → 配置 → 环境变量，
   补上 `CODING_PLAN_API_KEY`（改完约 5~10 秒自动重启，无需重新上传）。
   **日志里会顺带打印「本函数可见的相关环境变量名」**（只打印名字、不打印值），
   用来区分「名字拼错」和「配到了别的函数」。
3. 改了**代码**或 `shared/` 才需要重新部署（右键「上传并部署：云端安装依赖」）；只改环境变量不用

AI 失败时前端有**兜底逻辑**（按座位属性排序 / 基础统计文案），不会让页面崩溃。

### Q4：预约冲突但前端没拦截

**原因**：前端 `createReservation` 调用前已检查，但并发场景需依赖后端事务。

**解决**：当前实现是**应用层冲突检查**（写入前查同座位同时段重叠）。本项目记录里**没有 `reservation_id` 字段**，请勿创建 `{ reservation_id, status }` 唯一索引（会生成全空字段索引）。如查询慢/超时，检查 `records` 集合是否已建复合索引 `rec_room_seat_type_status_start`（`room_id + seat_id + record_type + status + start_at`）。

### Q5：seedData 失败

**排查**：
1. 云函数是否上传成功
2. 数据库是否有写权限（开发期间可临时放开：read/write 均为 `true`）
3. 云函数日志中是否有详细错误

### Q6：模拟器能跑但真机报 `cloud has not been initialized`

**原因**：真机的云开发环境 ID 与代码不一致。

**解决**：
1. 确认 `miniprogram/config/env.ts` 的 `CLOUD_ENV_ID` 已替换为生产环境
2. 重新构建 npm + 重新编译

### Q7：构建 npm 报错

**解决**：
```bash
rm -rf node_modules miniprogram/miniprogram_npm
npm install
# IDE → 工具 → 构建 npm
```

### Q8：开启位置签到后，人站在店里却签不上

按顺序排查：

1. **坐标口径错了**（最常见）：管理端选点必须用「地图选点」按钮，不要手抄高德/百度坐标（wgs84 / bd09），它们与 gcj02 差数百米。
2. **半径太小**：室内 GPS 漂移常见 30~80 米，半径设 20 米会大面积误拒，建议 **100~300 米**。
3. **定位精度被拒**（`GEO_LOW_ACCURACY`）：地下室/高楼内常只有基站定位，精度数百米。让用户靠窗或连店内 Wi-Fi 后重试，或调大 `CHECKIN_GEO_MAX_ACCURACY`。
4. **没申请接口权限**：mp 后台 → 开发 → 开发管理 → 接口设置，申请 `wx.getLocation`；并在「用户隐私保护指引」勾选位置信息。未申请时**只有真机会失败**，模拟器正常。
5. 拿不准时看签到记录里的 `payload.checkin_geo`（distance / accuracy），能直接看出是「真的远」还是「定位不准」。

---

## 附录 A：定时触发器配置（expireRecords）

`expireRecords` 云函数**默认不会自动运行**——必须显式在云开发控制台配定时触发器，否则：

- `pending_checkin` 过了 `start_at` 不会自动转 `no_show`
- `active` 过了 `end_at` 不会自动转 `completed`
- `leaveSeat` 设置的 `temp_leave_until` 过期后不会自动恢复占用
- 统计页面的「完成率 / 爽约率」永远不更新

### 推荐定时配置

| 项目 | 值 | 理由 |
|---|---|---|
| 函数名 | `expireRecords` | — |
| 触发方式 | **定时触发** | 不要选「API 触发」 |
| Cron 表达式 | `0 0 3 * * * *` | 每天凌晨 03:00 跑一次 |
| 入参 | `{}` | 默认全部扫描 |
| 并发 | 单实例即可 | 数据量小 |

### 控制台配置步骤

1. 微信云开发控制台 → 选中对应环境
2. 左侧 **云函数** → 找到 `expireRecords` → 点击进入
3. 顶部 **触发器** 标签 → **新建触发器**
4. 选择 **定时触发** → 填入 Cron 表达式 `0 0 3 * * * *`
5. 启用触发器 → 保存

### Cron 表达式速查（云开发 7 字段）

格式：`秒 分 时 日 月 星期 年`

| 表达式 | 含义 |
|---|---|
| `0 0 3 * * * *` | 每天 03:00（推荐） |
| `0 */30 * * * * *` | 每 30 分钟一次（演示用高频） |
| `0 0 0 * * * *` | 每天 00:00（午夜） |

### 验证是否生效

在触发器列表页应看到状态为 **运行中**。手动调用测试：

```
IDE → 云开发 → 云函数 → expireRecords → 测试
入参: {}
期望: success=true, data.expired_count ≥ 0
```

### 演示日临时跳过

如果希望演示当天不被自动清理（评委手动操作时段）：

1. 控制台 → `expireRecords` → 触发器 → **禁用**
2. 演示结束后再 **启用**

### 开发阶段建议

开发期间可以配 `0 */10 * * * * *`（每 10 分钟）来快速看到效果；上线前改回 `0 0 3 * * * *`。

---

## 附录 B：监控指标

| 指标 | 来源 | 告警阈值建议 |
|---|---|---|
| adminStats 调用频率 | 云函数日志 | > 100/分钟触发排查 |
| studyRecord abandon 比例 | 后台统计 | > 30% 触发产品调研 |
| 预约取消率 | 后台统计 | > 50% 触发调研 |
| FORBIDDEN 调用频率 | adminStats 日志 | > 10/小时触发白名单核查 |
---

## 附录 C：订阅消息（上线建议项）

打卡/签到场景最值得做的一件事：**预约成功后推送「预约成功」确认 + 到点「签到提醒」**。

### 代码已就绪，只差你一步

- 前端：`reservation.ts` 在预约成功后调用 `subpages/utils/subscribe.ts → requestSubscribe()` 拉授权，并通过 `subpages/services/notify.ts` 调 `notify` 云函数发推送。
- 云函数：新增 `cloudfunctions/notify`（action: `send`），调用 `cloud.openapi.subscribeMessage.send`。
- 未配置模板时整套链路**静默跳过，不报错、不阻塞**，所以现在就能上传使用。

### 你需要做的（控制台操作，约 5 分钟）

1. 微信公众平台 → **功能 → 订阅消息 → 我的模板 → 新增模板**，选/申请合适的模板
   （如「预约成功通知」「签到提醒」）。一次性订阅即可，长期订阅需类目支持。
2. 把拿到的模板 ID 填到 `miniprogram/subpages/config/subscribe.ts` 的 `SUBSCRIBE_TEMPLATES`
   （`reservationConfirmed` / `checkinReminder`）。
3. **或**配置到 `notify` 云函数的环境变量 `TPL_RESERVATION_CONFIRMED`（优先级同上）。
4. 对齐 `miniprogram/services/notify.ts` 里 `data` 的 **关键词 key**（如 `thing1/time2/thing3`）
   与你模板的「关键词」顺序一致，否则云端发不出去。
5. 上传 `notify` 云函数（右键 → 上传并部署：云端安装依赖）。

> 提示：`data` 里的字段是占位示例，必须按你申请的模板实际关键词改名。模板未配好前，
> 用户点「预约」会正常弹授权卡片但授权后无推送（无模板可发），这是预期行为。

---

## 附录 D：AI 功能提审合规（深度合成类目）⚠️ 必读

> 本项目**已对外提供 AI 生成内容**（学习页「AI 总结」、推荐页 AI 推荐），
> 只要 AI 内容对用户可见，微信就要求在**代码审核前**先取得对应服务类目，否则 **100% 驳回**。

### D.1 类目与主体要求

- 类目：**服务类目 → 深度合成 → AI 问答**（另有 AI 绘画 / AI 换脸 / AI 创作子类目）
- **仅非个人主体可申请**（企业 / 组织 / 个体工商户）。**个人主体无法开通**，官方建议改用 H5、公众号，
  或**小程序的客服消息**等替代方式承载 AI 功能。
- 类目审核时效：材料齐全 1~2 个工作日，最多 7 个工作日。
- **顺序铁律：先过类目，再提交代码包。** 反过来必驳回。

### D.2 资质材料（二选一）

| 路径 | 需要提供 | 周期 / 成本 |
|---|---|---|
| 自研技术 | 小程序主体的《互联网信息服务算法备案》（生成合成类），备案主体须与小程序主体完全一致 | 2–4 个月，3–13 万元 |
| **第三方技术（本项目适用）** | 技术方算法备案 + 双方盖章合作协议 | **免费，云开发平台直接生成** |

本项目 AI 能力可由云开发平台作为技术提供方出材料：

1. 前置：小程序已通过**企业认证**；云开发环境有效期 **≥ 3 个月**
2. 云开发控制台 → **AI** 模块 → **获取算法合作协议**
3. 填入小程序 AppID 与主体名称 → 平台生成两份材料：
   - ① 腾讯云《互联网信息服务算法备案》截图（算法类型：生成合成类 / 深度合成）
   - ② 《深度合成算法合作协议》
4. mp 后台 → 设置 → 基本设置 → **服务类目 → 添加「深度合成 > AI 问答」**
   → 选**资质 2.2（第三方技术）** → 上传上述两份材料

### D.3 三个高频驳回点（漏一个就被打回）

1. **AI 生成标识必须显著**：AI 对话/总结页面**全程固定展示**「由 AI 生成，仅供参考」，
   不能只在角落小字、不能只弹一次、不能浅色隐藏。
   - 现状：学习页有「AI 总结 / 基础总结」标签 —— 提审前建议强化为显式提示文案。
2. **用户协议 / 隐私政策补 AI 条款**：说明内容由人工智能生成、对话数据如何存储与过滤，
   并加入免责声明（不可用作医疗 / 法律 / 金融专业决策）。
3. **接入内容安全过滤**：用户输入与 AI 输出都需过 `security.msgSecCheck`。
   - 现状：AI 目前由云函数调用、输入为用户自身学习数据，风险低；若开放用户自由提问（AI 客服），
     **必须补 `msgSecCheck`**。

### D.4 相关文档

- 完整能力评估、AI 客服两条路径、成本与优先级：见 `docs/AI能力接入评估-2026-09-21.md`
