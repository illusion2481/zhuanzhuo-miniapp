/**
 * 修补 miniprogram_npm 里缺失 / 错位的 tslib
 *
 * ── 为什么会有这个脚本 ──────────────────────────────────────────────
 * tdesign-miniprogram 1.16.x 的产物开头是：
 *     import{__decorate}from"tslib";
 * 这是一个**裸包名**引用。小程序的 require 不会像 Node 那样去
 * miniprogram_npm 根找平级包，而是沿包目录向上找 node_modules，于是
 * 解析失败：
 *     module 'miniprogram_npm/tdesign-miniprogram/button/tslib.js' is not defined
 * 一个 tdesign 组件崩 = 全局 usingComponents 全崩 = custom-tab-bar 与
 * 所有页面一起报错。
 *
 * ── 三次复发的真正原因 ──────────────────────────────────────────────
 * 「构建 npm」每次都会**重写** miniprogram_npm，把本脚本的修补冲掉；
 * 并且它生成的产物**文件名是 index.js 而不是 tslib.js**。旧版脚本只认
 * tslib.js，于是每次构建完都认为是"修补丢失"，陷入
 *     构建 npm → 冲掉修补 → 报错 → 修补 → 再构建 → 再报错
 * 的死循环。
 *
 * 本脚本的对策：**先探测真实入口，再把裸引用改写成相对路径**。
 * 相对路径不依赖任何模块解析规则，指向哪个文件存在于当前磁盘就指哪个，
 * 所以无论构建 npm 把它叫做 index.js 还是 tslib.js 都能命中。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   npm run fix:tslib
 * 幂等，可反复执行。每次在开发者工具点过「构建 npm」之后，都要再跑一次。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const NPM_DIR = path.join(MP, 'miniprogram_npm');
const TD_DIR = path.join(NPM_DIR, 'tdesign-miniprogram');
const SUB_PKG = path.join(MP, 'package.json');
const SUB_MODULES = path.join(MP, 'node_modules');
const SUB_TSLIB = path.join(SUB_MODULES, 'tslib');
const ROOT_TSLIB = path.join(ROOT, 'node_modules', 'tslib');
const PREFER_TSLIB_DIR = path.join(NPM_DIR, 'tslib');

function log(msg) {
  console.log('[fix-tslib] ' + msg);
}
function fail(msg) {
  console.error('[fix-tslib] 失败：' + msg);
  process.exit(1);
}

// ── 1. miniprogram/package.json 必须有 tslib（构建 npm 读这一份） ──
if (fs.existsSync(SUB_PKG)) {
  const pkg = JSON.parse(fs.readFileSync(SUB_PKG, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  if (!pkg.dependencies.tslib) {
    pkg.dependencies.tslib = '^2.8.1';
    fs.writeFileSync(SUB_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log('miniprogram/package.json 已注入 tslib 依赖');
  } else {
    log('miniprogram/package.json 已含 tslib: ' + pkg.dependencies.tslib);
  }
} else {
  log('警告：没有 miniprogram/package.json，构建 npm 读不到依赖清单');
}

// ── 2. 保证有 tslib 源文件可搬运 ──
if (!fs.existsSync(path.join(SUB_TSLIB, 'tslib.js'))) {
  if (!fs.existsSync(path.join(ROOT_TSLIB, 'tslib.js'))) {
    fail('根 node_modules/tslib 不存在，请先在项目根执行 npm install tslib');
  }
  fs.mkdirSync(SUB_TSLIB, { recursive: true });
  // 递归复制（tslib 有多余的 modules/ 子目录，只复制文件会漏，但我们只需要根级文件）
  const copy = (srcDir, dstDir) => {
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const s = path.join(srcDir, e.name);
      const d = path.join(dstDir, e.name);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copy(ROOT_TSLIB, SUB_TSLIB);
  log('已复制 tslib 源到 miniprogram/node_modules');
}

// ── 3. 探测 miniprogram_npm 里真实存在的 tslib 入口 ──
//    构建 npm 的产物叫 index.js；本脚本手工补的叫 tslib.js。都认。
function pickEntry(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const name of ['index.js', 'tslib.js']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).size > 10000) {
      return { dir: dir, file: p, name: name };
    }
  }
  return null;
}

let entry = pickEntry(PREFER_TSLIB_DIR);
const version = JSON.parse(fs.readFileSync(path.join(SUB_TSLIB, 'package.json'), 'utf8')).version;

if (!entry) {
  // 构建 npm 没产出，手工补一份
  fs.mkdirSync(PREFER_TSLIB_DIR, { recursive: true });
  fs.copyFileSync(path.join(SUB_TSLIB, 'tslib.js'), path.join(PREFER_TSLIB_DIR, 'tslib.js'));
  entry = pickEntry(PREFER_TSLIB_DIR);
  log('构建产物里没有 tslib，已手工补一份');
}
if (!entry) fail('无法在 miniprogram_npm 里建立 tslib 入口');

// 保证有 package.json，且 main 指向真实入口文件
const mainPkgPath = path.join(entry.dir, 'package.json');
let needWrite = true;
if (fs.existsSync(mainPkgPath)) {
  try {
    const cur = JSON.parse(fs.readFileSync(mainPkgPath, 'utf8'));
    needWrite = cur.main !== entry.name;
  } catch (e) {
    needWrite = true;
  }
}
if (needWrite) {
  fs.writeFileSync(
    mainPkgPath,
    JSON.stringify({ name: 'tslib', version: version, main: entry.name }, null, 2) + '\n',
    'utf8'
  );
}

// ── 4. 改写 tdesign 产物里的裸引用 ──
const ESM_TSLIB = /(\bfrom\s*)(["'])tslib\2/g;
const CJS_TSLIB = /require\(\s*["']tslib["']\s*\)/g;
const BARE_TSLIB = /(\bfrom\s*["']tslib["'])|(require\(\s*["']tslib["']\s*\))/;
// 上一轮可能改写成了 ../tslib/tslib.js 或 ../tslib/index.js，
// 先归一化回裸引用，避免指向已经不存在的文件。
const WRITTEN_ESM = /(\bfrom\s*)(["'])([^"']*?\btslib\/(?:tslib|index)\.js)\2/g;
const WRITTEN_CJS = /require\(\s*["']([^"']*?\btslib\/(?:tslib|index)\.js)["']\s*\)/g;

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

let patched = 0;
let touched = 0;
for (const file of walk(TD_DIR)) {
  let code = fs.readFileSync(file, 'utf8');
  const before = code;

  // 归一化旧改写 → 裸引用
  code = code.replace(WRITTEN_ESM, '$1$2tslib$2').replace(WRITTEN_CJS, 'require("tslib")');
  if (!BARE_TSLIB.test(code)) continue;

  // 裸引用 → 指向真实入口的相对路径
  const rel = path.relative(path.dirname(file), entry.dir).split(path.sep).join('/');
  const target = rel + '/' + entry.name;
  code = code
    .replace(ESM_TSLIB, '$1$2' + target + '$2')
    .replace(CJS_TSLIB, 'require("' + target + '")');

  if (code !== before) {
    fs.writeFileSync(file, code, 'utf8');
    patched += 1;
  }
  touched += 1;
}

// ── 5. 自检：裸引用必须归零，且每个相对目标必须真实存在 ──
let bare = 0;
let dead = 0;
const seen = new Set();
for (const file of walk(TD_DIR)) {
  const code = fs.readFileSync(file, 'utf8');
  if (BARE_TSLIB.test(code)) bare += 1;
  const re = /(?:from|require\()\s*["']([^"']*?\btslib\/(?:tslib|index)\.js)["']/g;
  let m;
  while ((m = re.exec(code))) {
    const key = m[1] + '@' + file;
    if (seen.has(key)) continue;
    seen.add(key);
    const abs = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(abs)) {
      dead += 1;
      if (dead <= 5) log('  死链: ' + m[1] + '  <-  ' + path.relative(MP, file));
    }
  }
}

log('入口: ' + path.relative(MP, entry.file) + '  v' + version);
log('含 tslib 引用的文件: ' + touched + ' ，本轮改写: ' + patched);
if (bare > 0) fail('仍有 ' + bare + ' 个文件带裸引用 tslib');
if (dead > 0) fail('有 ' + dead + ' 条改写指向不存在的文件');
log('OK  裸引用已归零，所有改写目标均存在');
