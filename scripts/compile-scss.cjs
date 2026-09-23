/**
 * SCSS 真编译检查（本地版「真机调试」前置防线）。
 *
 * 为什么需要：tsc / ESLint / 云逻辑测试都**抓不到样式错误**。
 * `Undefined variable` 这类问题只在开发者工具编译或真机调试时才炸，
 * 例如 2026-09-21 真机报错 `$radius-xs` 未定义（admin.scss 引用了不存在的变量）。
 * 本脚本用 Dart Sass 把全量页面/组件 SCSS 编译一遍，秒级定位。
 *
 * 用法：node scripts/compile-scss.cjs
 * 依赖：sass。优先用项目 devDependencies，缺失时回退到隔离工作区那份（不存在则提示安装）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const FALLBACK_SASS =
  'C:\\Users\\28459\\.workbuddy\\binaries\\node\\workspace\\node_modules\\sass';

function loadSass() {
  try {
    return require('sass');
  } catch {
    /* 项目未安装，尝试隔离工作区 */
  }
  try {
    return require(FALLBACK_SASS);
  } catch {
    console.error('未找到 sass，请先安装：npm i -D sass（或用隔离工作区那份）');
    process.exit(2);
  }
}

const sass = loadSass();

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      // 第三方与构建产物不参与编译
      if (name === 'node_modules' || name === 'miniprogram_npm') continue;
      walk(full, out);
    } else if (name.endsWith('.scss') && !name.startsWith('_')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
let fail = 0;
let ok = 0;

for (const f of files) {
  try {
    sass.compile(f, {
      loadPaths: [ROOT, path.join(ROOT, 'styles')],
      // @import 弃用警告刷屏，静音；真正的错误仍会抛出
      silenceDeprecations: ['import'],
      quietDeps: true,
    });
    ok += 1;
  } catch (e) {
    fail += 1;
    const msg = String((e && e.message) || e).split('\n').slice(0, 5).join('\n  ');
    console.log('FAIL ' + path.relative(ROOT, f) + '\n  ' + msg);
  }
}

console.log(`\nscss compile: ok=${ok} fail=${fail} total=${files.length}`);
process.exit(fail ? 1 : 0);
