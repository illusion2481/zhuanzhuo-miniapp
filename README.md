# 专注座（FocusSeat）微信小程序

帮助学生找到合适的自习座位，并通过预约、签到、暂离管理和 AI 学习辅助提升自习效率。

## 项目状态

按 [Plan v2](docs/Plan-v2.md) 推进：Phase 1~7 已交付代码（**仅本地验证**，需云开发控制台部署云函数），Phase 8 交付准备进行中。

| Phase | 模块 | 状态 |
|---|---|---|
| 1 | 项目基础 / 配置 / 类型骨架 | ✅ 完成 |
| 2 | 数据 / 登录 / 用户档案 | ✅ 完成 |
| 3 | 分类 / 自习室 / 座位浏览 | ✅ 完成 |
| 4 | 预约业务闭环 / 签到 / 暂离 | ✅ 完成 |
| 5 | 暂离与学习记录 / 番茄钟 | ✅ 完成 |
| 6 | AI 推荐与总结 | ✅ 完成 |
| 7 | 管理后台与统计（含鉴权） | ✅ 完成 |
| 8 | 交付准备（部署 / 文档） | 🔄 进行中 |

## 技术栈

- 小程序：微信原生 + TypeScript
- UI：TDesign Miniprogram
- 后端：微信云开发 CloudBase（云函数 + 云数据库）
- AI：Deepseek-v4-flash / GLM-5.2（经 Coding Plan API，仅云函数调用）

## 快速开始（本地开发）

```bash
# 1. 安装依赖（仅 IDE 内 npm 构建需要）
npm install

# 2. 复制环境变量模板
cp .env.example .env
# ⚠️ .env 已被 .gitignore 忽略；不要把真实 key 提交到 Git

# 3. 用微信开发者工具打开本目录（zhuanzhuo-miniapp）
#    工具栏 → 工具 → 构建 npm（生成 miniprogram_npm）
```

## 云函数部署与运维

详细的部署手册见 [docs/DEPLOY.md](docs/DEPLOY.md)。简要步骤：

1. 云开发控制台创建环境，将环境 ID 写入 `miniprogram/config/env.ts`
2. 在云函数配置面板注入环境变量：`CLOUD_ENV_ID`、`CODING_PLAN_API_KEY`、`ADMIN_OPENID_HASHES`
3. 按以下顺序上传云函数（**login 必须在 adminStats 之前**）：
   - `login` → `seedData` → `categoryList` → `roomList` → `createReservation` → `cancelReservation` → `checkin` → `leaveSeat` → `expireRecords` → `studyRecord` → `aiRecommend` → `aiSummary` → `adminStats`
4. 微信开发者工具 → 云开发 → 数据库 → 初始化集合（按 [docs/database.md](docs/database.md)）

## 管理员权限

`adminStats` 云函数依赖 `ADMIN_OPENID_HASHES` 环境变量（白名单）。配置步骤：

1. 取你**自己的微信号**对应 openid 的 sha256 前 32 位
2. 在云函数 adminStats 的「配置 → 环境变量」粘贴到 `ADMIN_OPENID_HASHES`
3. 多个管理员用英文逗号分隔

未配置环境变量时，adminStats 会返回 `ADMIN_NOT_CONFIGURED`；非白名单用户访问返回 `FORBIDDEN`。

## 演示与体验号

- 演示数据：通过 [scripts/seedDemoData.ts](scripts/seedDemoData.ts) 写入 13 个分类 + 2 条演示预约
- 演示账号：在 [docs/demo-script.md](docs/demo-script.md) 列出
- 体验号加入流程：[docs/DEPLOY.md#体验号加入白名单](docs/DEPLOY.md)

## 目录概览

```text
miniprogram/      # 小程序端
cloudfunctions/   # 云函数（按职责拆分子目录）
scripts/          # 种子数据 / 演示脚本
docs/             # 设计、测试、部署文档
```

## 脚本

```bash
npm run typecheck       # TypeScript 类型检查
npm run lint            # ESLint 检查
npm run lint:fix        # ESLint 自动修复
npm run format          # Prettier 自动格式化
npm run format:check    # Prettier 检查（不改文件）
npm run seed:check      # 校验种子数据完整性
npm run test:cloud      # 云函数逻辑测试（本地内存 mock，84 例）
```

## 安全约束

- **禁止**将 API Key / OpenID 写入小程序前端、`app.ts`、`utils/`、`services/`
- **禁止**将 `.env`、`.env.local`、`*.pem`、`*.key` 提交到 Git（`.gitignore` 已配置）
- **禁止**明文存储用户 OpenID（统一使用 sha256(openid).slice(0, 32) 哈希）
- **禁止**未鉴权暴露管理接口（adminStats 强制校验 ADMIN_OPENID_HASHES）

## 许可

私有项目，仅用于课程/比赛交付。