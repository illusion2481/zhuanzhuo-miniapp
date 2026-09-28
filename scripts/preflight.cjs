#!/usr/bin/env node
'use strict'
/**
 * 专注座 P0 上线 Pre-flight 静态体检脚本
 * ------------------------------------------------------------------
 * 不依赖微信云控制台，纯本地扫描源码，吐出「上线前必查」清单：
 *   1) 23 个云函数（排除 shared 公共库）的 package.json / config.json / shared 目录
 *   2) 环境变量引用映射（关键 vs 可选）
 *   3) 数据库集合引用（对比文档声明）
 *   4) 订阅模板 ID 是否为空（空 = 静默跳过）
 *   5) 前端 IS_DEV 当前值（上线必须为 false）
 *
 * 用法：node scripts/preflight.cjs
 * 输出：PASS / WARN / FAIL 三档结论，可直接照着勾。
 */

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const CF_DIR = path.join(ROOT, 'cloudfunctions')
const MINI_DIR = path.join(ROOT, 'miniprogram')

// ---------- 通用工具 ----------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** 递归收集 dir 下所有 .js，跳过 exclude 命名的目录（默认 node_modules） */
function walk(dir, exclude) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        if (exclude.includes(e.name)) continue
        stack.push(full)
      } else if (e.isFile() && e.name.endsWith('.js')) {
        out.push(full)
      }
    }
  }
  return out
}

// ---------- 1. 枚举可部署云函数 ----------
const allDirs = fs.readdirSync(CF_DIR).filter((name) => {
  const p = path.join(CF_DIR, name)
  if (!fs.statSync(p).isDirectory()) return false
  return fs.existsSync(path.join(p, 'index.js')) // 顶层 shared 库无 index.js，自动排除
}).sort()

const SKIP_DEPLOY = new Set(['weeklyReport']) // 功能已于 2026-09-27 删除

const funcs = []
const envVars = {}        // var -> Set(func)
const collections = new Set()

for (const name of allDirs) {
  const fdir = path.join(CF_DIR, name)
  const pkg = readJson(path.join(fdir, 'package.json'))
  const cfg = readJson(path.join(fdir, 'config.json'))
  const hasShared = fs.existsSync(path.join(fdir, 'shared')) &&
    fs.statSync(path.join(fdir, 'shared')).isDirectory()

  const jsFiles = walk(fdir, ['node_modules'])
  let content = ''
  for (const f of jsFiles) {
    try { content += fs.readFileSync(f, 'utf8') + '\n' } catch { /* ignore */ }
  }
  const requireShared = /require\(\s*['"`][^'"`]*shared/.test(content)
  const uploadAll = hasShared || requireShared

  const envSet = new Set()
  const envRe = /process\.env\.([A-Za-z0-9_]+)/g
  let m
  while ((m = envRe.exec(content))) envSet.add(m[1])
  for (const v of envSet) (envVars[v] = envVars[v] || new Set()).add(name)

  const colRe = /db\.collection\(\s*['"]([\w]+)['"]\s*\)/g
  while ((m = colRe.exec(content))) collections.add(m[1])

  funcs.push({ name, hasPkg: !!pkg, cfg, hasShared, uploadAll, env: [...envSet] })
}

// ---------- 2. 环境变量分类 ----------
// 关键：不配 → 功能直接挂 / 管理端全拒
const CRITICAL = {
  ADMIN_OPENID_HASHES: '管理端鉴权：adminOps / adminStats / adminSeatMaintain 路由全依赖，不配则管理员全部被拒',
  CODING_PLAN_API_KEY: 'AI 通道：aiChat / aiRecommend / aiSummary 调用 Coding Plan 的密钥，不配则 AI 全部降级',
}
// 可选：代码内已硬编码默认值，不配也能跑
const OPTIONAL = {
  CODING_PLAN_BASE_URL: 'AI 基础 URL（有默认）',
  CODING_PLAN_MODEL: 'AI 模型名（有默认）',
  CHECKIN_REQUIRE_CODE: "签到码开关（默认 '1'=需要）",
  TPL_RESERVATION_CONFIRMED: '订阅模板① ID（代码内已硬编码默认）',
  TPL_CHECKIN_REMINDER: '订阅模板② ID（代码内已硬编码默认）',
  TPL_RESERVATION_WARN: '订阅模板③ ID（代码内已硬编码默认）',
  TPL_RESERVATION_CANCEL: '订阅模板④ ID（代码内已硬编码默认）',
  CHECKIN_GEO_RADIUS: '签到地理围栏半径（米，有默认）',
  CHECKIN_GEO_MAX_ACCURACY: '签到定位最大允许精度（米，有默认）',
}

// ---------- 3. 订阅模板 ----------
const subFile = path.join(MINI_DIR, 'subpages', 'config', 'subscribe.ts')
let subContent = ''
try { subContent = fs.readFileSync(subFile, 'utf8') } catch { subContent = '' }
const templates = {}
const subRe = /^\s{2}(\w+):\s*'([^']*)'/gm
let m
while ((m = subRe.exec(subContent))) templates[m[1]] = m[2]

// ---------- 4. IS_DEV ----------
const envFile = path.join(MINI_DIR, 'config', 'env.ts')
let isDev = '(未找到)'
try {
  const ec = fs.readFileSync(envFile, 'utf8')
  const mm = ec.match(/IS_DEV\s*=\s*(true|false)/)
  if (mm) isDev = mm[1]
} catch { /* ignore */ }

// ---------- 5. 集合对比 ----------
const EXPECTED_COLLECTIONS = ['users', 'records', 'categories', 'reviews', 'audit_logs']
const discovered = [...collections].sort()
const docsOnly = EXPECTED_COLLECTIONS.filter((c) => !collections.has(c)) // 文档列但代码未用

// ---------- 6. 主包孤儿模块（仅被分包引用 / 无引用 → 上传时「代码质量」会点名） ----------
function walkTs(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'miniprogram_npm') continue
      walkTs(full, out)
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}
function tsDepsOf(file) {
  let src = ''
  try { src = fs.readFileSync(file, 'utf8') } catch { return [] }
  src = src.replace(/^\s*import\s+type\s[^;]*;/gm, '') // 纯类型导入编译后不产生 require
  const out = []
  const re = /(?:from\s+|import\s+|require\(\s*)['"](\.[^'"]+)['"]/g
  let mm
  while ((mm = re.exec(src))) out.push(mm[1])
  return out
}
function tsResolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  if (fs.existsSync(base + '.ts')) return base + '.ts'
  if (fs.existsSync(path.join(base, 'index.ts'))) return path.join(base, 'index.ts')
  return null
}
const tsFiles = walkTs(MINI_DIR, [])
const tsRequirers = new Map()
for (const f of tsFiles) {
  for (const spec of tsDepsOf(f)) {
    const dep = tsResolve(f, spec)
    if (!dep) continue
    if (!tsRequirers.has(dep)) tsRequirers.set(dep, new Set())
    tsRequirers.get(dep).add(f)
  }
}
const isSub = (f) => path.relative(MINI_DIR, f).split(path.sep)[0] === 'subpages'
const tsRoots = tsFiles.filter((f) => {
  const r = path.relative(MINI_DIR, f)
  const top = r.split(path.sep)[0]
  return r === 'app.ts' || top === 'pages' || top === 'custom-tab-bar' || top === 'components'
})
const tsReachable = new Set(tsRoots)
const tsQueue = [...tsRoots]
while (tsQueue.length) {
  const f = tsQueue.shift()
  for (const spec of tsDepsOf(f)) {
    const dep = tsResolve(f, spec)
    if (dep && !tsReachable.has(dep)) { tsReachable.add(dep); tsQueue.push(dep) }
  }
}
const orphans = tsFiles.filter((f) => !isSub(f) && !tsReachable.has(f))
const orphansDead = orphans.filter((f) => !(tsRequirers.get(f) || []).size)
const orphansSub = orphans.filter((f) => (tsRequirers.get(f) || []).size)

// ---------- 输出 ----------
const L = []
const line = (s) => L.push(s)
const box = (s) => { L.push(''); L.push(s); L.push('') }

line('╔══════════════════════════════════════════════════════════════')
line('  专注座 P0 上线 Pre-flight 体检')
line('  生成时间: ' + new Date().toISOString())
line('╚══════════════════════════════════════════════════════════════')

box('【1】云函数清单  (' + funcs.length + ' 个可部署 + shared 公共库)')
const missingPkg = funcs.filter((f) => !f.hasPkg)
line('  ' + (missingPkg.length ? '❌' : '✅') + ' package.json：' +
  (missingPkg.length ? '缺失 → ' + missingPkg.map((f) => f.name).join(', ')
                     : '23 个全部存在（不会踩「漏 package.json 加载即失败」的坑）'))

const withCfg = funcs.filter((f) => f.cfg)
line('  ⚙️  config.json（含超时/触发器）:')
for (const f of withCfg) {
  const t = f.cfg.timeout ? f.cfg.timeout + 's' : '-'
  const tri = (f.cfg.triggers || []).map((x) => x.config).join(', ') || '无'
  line('      • ' + f.name.padEnd(20) + ' timeout=' + String(t).padEnd(5) + ' triggers=[' + tri + ']')
}

const uploadAll = funcs.filter((f) => f.uploadAll)
line('  📦 须「上传并部署：所有文件」的函数（含 shared 目录或引用根 shared 库）:')
line('      ' + uploadAll.map((f) => f.name).join(', '))

line('  ⛔ 弃部署: weeklyReport —— 订阅每周总结推送功能已于 2026-09-27 删除，请勿部署（目录保留不删）')

box('【2】环境变量')
line('  ❌ 关键（控制台必配，否则功能直接挂）:')
for (const v of Object.keys(CRITICAL)) {
  const users = [...(envVars[v] || [])].join(', ') || '（未发现引用）'
  line('      • ' + v + '  ←  ' + users)
  line('        ' + CRITICAL[v])
}
line('  🟡 可选（代码内已硬编码默认值，可不配）:')
for (const v of Object.keys(OPTIONAL)) {
  const users = [...(envVars[v] || [])].join(', ') || '（未发现引用）'
  line('      • ' + v + '  ←  ' + users + '  [' + OPTIONAL[v] + ']')
}
// 发现但既非关键也非可选的变量
const known = new Set([...Object.keys(CRITICAL), ...Object.keys(OPTIONAL)])
const unknown = Object.keys(envVars).filter((v) => !known.has(v))
if (unknown.length) {
  line('  ⚠️  其他引用（请人工确认是否需配置）: ' + unknown.map((v) =>
    v + '←' + [...envVars[v]].join('/')).join('  '))
}

box('【3】数据库集合')
line('  云端代码实际引用: ' + discovered.join(', '))
if (docsOnly.length) {
  line('  ⚠️  文档声明但无任何云函数读写（建着无害，属文档遗留）: ' + docsOnly.join(', '))
}
line('  控制台需手动创建: users / records / categories / reviews' +
  (docsOnly.length ? '  （+ ' + docsOnly.join('/') + ' 可选）' : ''))
line('  ★ reviews 必须先建！不建 → submitReview 评价提交直接失败')

box('【4】订阅模板（空 ID = 静默跳过，用户永远收不到）')
const tplList = Object.keys(templates)
for (const k of tplList) {
  const empty = templates[k] === ''
  line('  ' + (empty ? '⚠️ ' : '✅') + ' ' + k.padEnd(20) + (empty ? '（空 → 跳过）' : '已填真实 ID'))
}
if (!tplList.length) line('  （未解析到模板，请检查 subscribe.ts）')

box('【5】前端环境开关')
line('  IS_DEV = ' + isDev + '   ' + (isDev === 'true' ? '❌ 上线前必须改为 false（miniprogram/config/env.ts）' : '✅'))

box('【6】主包孤儿模块（上传时「代码质量 → 未使用的JS文件」会点名）')
if (!orphans.length) {
  line('  ✅ 无：主包每个 TS 模块都被主包可达引用')
} else {
  for (const f of orphansSub) {
    const rq = [...tsRequirers.get(f)].map((x) => path.relative(MINI_DIR, x).replace(/\\/g, '/')).join(', ')
    line('  ⚠️  仅分包引用（建议搬进 subpages/）: ' + path.relative(MINI_DIR, f).replace(/\\/g, '/') + '  ← ' + rq)
  }
  for (const f of orphansDead) {
    line('  ⚠️  无任何引用（死代码，建议删除）: ' + path.relative(MINI_DIR, f).replace(/\\/g, '/'))
  }
}

box('══════════ 上线结论  ════════════')
const blockers = []
if (isDev === 'true') blockers.push('IS_DEV 仍为 true —— 上线版会暴露开发工具且走开发路径')
if (missingPkg.length) blockers.push('存在云函数缺 package.json —— 加载即失败')
if (blockers.length) {
  line('❌ 未就绪（阻断项）:')
  blockers.forEach((b) => line('   - ' + b))
} else {
  line('✅ 无阻断项')
}
line('⛔ 部署时跳过 weeklyReport（功能已删）')
line('📋 控制台操作核对单见本轮对话附带的 P0 上线核对单')
line('')

const out = L.join('\n')
console.log(out)

// 写一份副本到 build/ 方便查阅
try {
  const buildDir = path.join(ROOT, 'build')
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true })
  fs.writeFileSync(path.join(buildDir, 'preflight-report.txt'), out, 'utf8')
} catch { /* ignore */ }
