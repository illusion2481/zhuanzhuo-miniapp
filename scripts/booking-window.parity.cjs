/**
 * 预约时段截断（clamp）三处实现的一致性核对
 * -------------------------------------------------------
 * 运行：node scripts/booking-window.parity.cjs
 *
 * 为什么要单独一条核对：
 *   同一套「夹到开放时段」的规则被实现了三次 ——
 *     前端 miniprogram/subpages/utils/bookingWindow.ts（决定给用户看什么时段）
 *     cloudfunctions/createReservation/index.js（决定下单放不放行）
 *     cloudfunctions/updateReservation/index.js（决定改约放不放行）
 *   任一处走样，用户就会看到「页面显示 20:33-22:00，提交后却变成别的时段」
 *   或者「页面显示能约、提交被拒」。纯靠人记不可能守住。
 *
 * 做法：把真实源码里的函数体抽出来执行（不是复述一份实现），
 *       再用同一组输入逐条比对输出。前端 TS 先用 tsc 编译到临时目录。
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(ROOT, '.tmp-bw-parity')

function log(msg) { console.log(msg) }

// ---------- 1. 编译前端 util ----------
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!fs.existsSync(tsc)) {
  console.error('找不到 typescript，无法编译前端 util：' + tsc)
  process.exit(2)
}
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const emit = spawnSync(
  process.execPath,
  [tsc, 'miniprogram/subpages/utils/bookingWindow.ts', '--outDir', TMP,
    '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck', '--moduleResolution', 'node'],
  { cwd: ROOT, encoding: 'utf8' },
)
if (emit.status !== 0) {
  console.error('tsc 编译失败：\n' + (emit.stdout || '') + (emit.stderr || ''))
  process.exit(2)
}
// 项目根 package.json 是 "type":"module"，临时目录里声明 commonjs 才能 require
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"commonjs"}')
const fe = require(path.join(TMP, 'subpages', 'utils', 'bookingWindow.js'))

// ---------- 2. 从云函数源码里抽出真实 clamp 实现 ----------
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error('未找到函数：' + name)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  throw new Error('花括号不配对：' + name)
}

function loadServerClamp(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const minConst = /const MIN_BOOKING_MINUTES = \d+/.exec(src)
  if (!minConst) throw new Error(file + ' 里找不到 MIN_BOOKING_MINUTES')
  const code = [
    minConst[0],
    extractFn(src, 'toMin'),
    extractFn(src, 'beijingParts'),
    extractFn(src, 'minToHHmm'),
    extractFn(src, 'beijingToIso'),
    extractFn(src, 'clampToOpenWindow'),
    'return { clampToOpenWindow }',
  ].join('\n')
  return new Function(code)().clampToOpenWindow
}

const clampCr = loadServerClamp('cloudfunctions/createReservation/index.js')
const clampUr = loadServerClamp('cloudfunctions/updateReservation/index.js')

// ---------- 3. 断言工具 ----------
let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; log('  PASS ' + name) } else { fail++; log('  FAIL ' + name + ' ' + detail) }
}

const D = '2026-10-01' // 固定日期，避免受运行时刻影响
const iso = (day, t) => new Date(`${day}T${t}:00+08:00`).toISOString()
const bj = (isostr) => {
  const d = new Date(new Date(isostr).getTime() + 8 * 3600e3)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 同一组输入分别跑前端与云端，断言实际落库的时刻完全一致 */
function compare(label, o) {
  const f = fe.planBookingWindow({
    startDate: D,
    startTime: o.startTime,
    durationMinutes: o.durationMinutes,
    manualEndTime: o.manualEndTime,
    openTime: o.openTime,
    closeTime: o.closeTime,
  })
  const s = clampCr(iso(D, o.startTime), o.serverEnd || iso(D, o.startTime), o.openTime, o.closeTime)
  if (!s.ok) {
    check(label, false, '云端意外拒绝：' + s.message)
    return
  }
  check(
    label,
    s.start_at === iso(f.startDate, f.startTime) && bj(s.end_at) === f.endTime,
    `云端 ${bj(s.start_at)}-${bj(s.end_at)} / 前端 ${f.startTime}-${f.endTime}`,
  )
}

// ---------- 4. 前端 vs 云端 ----------
log('\n== 前端 planBookingWindow vs 云端 clampToOpenWindow ==')
compare('20:33 约 2 小时 → 截断到 22:00', {
  startTime: '20:33', durationMinutes: 120, serverEnd: iso(D, '22:33'), openTime: '08:00', closeTime: '22:00',
})
compare('21:00 约 4 小时（跨天）→ 截断到 22:00', {
  startTime: '21:00', durationMinutes: 240, serverEnd: iso('2026-10-02', '01:00'), openTime: '08:00', closeTime: '22:00',
})
compare('07:00 早于开门 → 前推到 08:00，结束时间保持用户原意', {
  startTime: '07:00', durationMinutes: 120, serverEnd: iso(D, '09:00'), openTime: '08:00', closeTime: '22:00',
})
compare('手动结束 21:30 → 按 90 分钟落库', {
  startTime: '20:00', durationMinutes: 60, manualEndTime: '21:30', serverEnd: iso(D, '21:30'), openTime: '08:00', closeTime: '22:00',
})
compare('完全落在开放时段内 → 原样通过', {
  startTime: '20:00', durationMinutes: 60, serverEnd: iso(D, '21:00'), openTime: '08:00', closeTime: '22:00',
})
compare('未配置开放时段 → 不做截断', {
  startTime: '23:00', durationMinutes: 40, serverEnd: iso(D, '23:40'), openTime: '', closeTime: '',
})

// ---------- 5. 前端顺延到次日的时段必须被云端接受 ----------
log('\n== 前端「顺延到次日」的结果必须能被云端接受 ==')
const rolled = fe.planBookingWindow({
  startDate: D, startTime: '22:30', durationMinutes: 60, openTime: '08:00', closeTime: '22:00',
})
check('前端把 22:30 顺延到次日 08:00',
  rolled.startDate === '2026-10-02' && rolled.startTime === '08:00' && rolled.clamped, JSON.stringify(rolled))
const accepted = clampCr(iso(rolled.startDate, rolled.startTime), iso(rolled.endDate, rolled.endTime), '08:00', '22:00')
check('顺延后的时段云端放行且不再改动',
  accepted.ok && bj(accepted.start_at) === '08:00' && bj(accepted.end_at) === '09:00', JSON.stringify(accepted))

const short = fe.planBookingWindow({
  startDate: D, startTime: '21:50', durationMinutes: 40, openTime: '08:00', closeTime: '22:00',
})
check('前端把「只剩 10 分钟」也顺延到次日（不放空号）',
  short.startDate === '2026-10-02' && short.durationMinutes === 40, JSON.stringify(short))

// ---------- 6. 两个云函数的 clamp 必须完全同构 ----------
log('\n== createReservation 与 updateReservation 的 clamp 必须完全同构 ==')
const cases = [
  [iso(D, '20:33'), iso(D, '22:33'), '08:00', '22:00'],
  [iso(D, '07:00'), iso(D, '09:00'), '08:00', '22:00'],
  [iso(D, '21:50'), iso(D, '22:30'), '08:00', '22:00'],
  [iso(D, '22:30'), iso(D, '23:30'), '08:00', '22:00'],
  [iso(D, '10:00'), iso(D, '12:00'), '', ''],
  [iso(D, '23:00'), iso(D, '23:40'), '22:00', '06:00'],
]
cases.forEach(([s, e, o, c], i) => {
  const a = JSON.stringify(clampCr(s, e, o, c))
  const b = JSON.stringify(clampUr(s, e, o, c))
  check(`第 ${i + 1} 组两函数输出一致`, a === b, `\n    createReservation=${a}\n    updateReservation=${b}`)
})

log(`\n==== booking-window parity: pass=${pass} fail=${fail} ====`)

// ---------- 清理 ----------
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
