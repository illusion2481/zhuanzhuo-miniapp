#!/usr/bin/env node
/**
 * trim-tdesign.cjs — 裁剪 tdesign-miniprogram 构建产物
 *
 * 背景：miniprogram_npm/tdesign-miniprogram 全量打包约 3.6MB / 102+ 目录，
 * 项目实际只用到 6 个组件（button/loading/empty/tag/toast/popup）。
 * 其余目录全部打进上传包，是主包超 2MB 的头号元凶。
 *
 * 做法（可逆）：
 *   1. 白名单 = 在用组件 + 其依赖（icon/overlay/image）+ common/mixins + 根文件
 *   2. 程序化解析「保留目录内所有文件的相对引用」，自动补全被依赖的目录
 *   3. 白名单之外 → mv 到根目录 _backup-20260922/tdesign-trimmed/（不直接删）
 *   4. 自检：保留目录内所有相对引用（js/json/wxml/wxss）对端必须存在
 *
 * ⚠️ 注意：开发者工具「构建 npm」会从 node_modules 重新生成全部目录，
 *   把裁剪冲掉 —— 裁剪后请勿再点「构建 npm」，或点完重跑本脚本。
 *   node_modules/tdesign-miniprogram 源始终完整不动，随时可恢复。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TD = path.join(ROOT, 'miniprogram/miniprogram_npm/tdesign-miniprogram');
const BK = path.join(ROOT, '_backup-20260922/tdesign-trimmed');

/** 在用组件（app.json / 页面 json 引用，见业务代码） */
const KEEP_COMPONENTS = ['button', 'loading', 'empty', 'tag', 'toast', 'popup'];
/** 依赖闭包保底保留目录（被 require/usingComponents 命中） */
const KEEP_EXTRA = ['icon', 'overlay', 'image', 'common', 'mixins'];
/** 根级文件必须保留（其余根文件如各类 json 也一并保留） */
const KEEP_ROOT_FILES = ['index.js', 'index.d.ts', '.wechatide.ib.json'];

const keep = new Set([...KEEP_COMPONENTS, ...KEEP_EXTRA]);

function dirSize(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let s = 0;
  for (const f of fs.readdirSync(p)) s += dirSize(path.join(p, f));
  return s;
}

/** 收集目录内所有文件的相对引用（js import/require、json usingComponents、wxml import/include、wxss @import） */
function collectRefs(dir) {
  const out = new Set();
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) continue;
    const ext = path.extname(f).toLowerCase();
    if (!['.js', '.json', '.wxml', '.wxss', '.wxs'].includes(ext)) continue;
    let text = '';
    try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    // JS: import/export/require（含压缩后的 from"" 形式）
    for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      out.add(m[1]);
    }
    // JSON: usingComponents / componentGenerics / componentPlaceholder 等
    try {
      const j = JSON.parse(text);
      if (j.usingComponents) for (const v of Object.values(j.usingComponents)) out.add(String(v));
      if (j.componentPlaceholder) for (const v of Object.values(j.componentPlaceholder)) out.add(String(v));
      if (j.componentGenerics) for (const v of Object.values(j.componentGenerics)) out.add(String(v));
    } catch { /* 非 json */ }
    // WXML: <import src> / <include src>
    for (const m of text.matchAll(/(?:import|include)\s+src\s*=\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
    // WXSS: @import "x"
    for (const m of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  return out;
}

/** 引用字符串 → 绝对路径；返回 null 视为外部依赖（tdesign 之外） */
function resolveRef(ref, fromDir) {
  if (!ref || ref.startsWith('/')) return null;
  if (/^(node_modules|miniprogram_npm|tdesign-miniprogram)\//.test(ref)) return null;
  if (!ref.startsWith('.')) return null; // 非相对引用（如全局名）不处理
  return path.resolve(fromDir, ref);
}

/** 绝对路径 → TD 下顶层目录名；TD 之外或 TD 本身返回 null */
function dirOf(p) {
  if (!p.startsWith(TD + path.sep)) return null;
  let d = p;
  // 向上找最近存在实体（引用可能到 .js 但文件是 .d.ts 等）
  while (d.startsWith(TD) && !fs.existsSync(d)) d = path.dirname(d);
  if (d === TD) return null;
  const rel = path.relative(TD, d);
  const top = rel.split(path.sep)[0];
  return top || null;
}

function main() {
  console.log('[tdesign] 裁剪前体积:');
  const before = dirSize(TD);
  console.log('  ', (before / 1024).toFixed(1), 'KB (', (before / 1024 / 1024).toFixed(2), 'MB )');

  // 1) 闭包：从白名单出发迭代解析依赖
  const resolved = new Set(keep);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 30) {
    changed = false;
    const snapshot = [...resolved];
    for (const d of snapshot) {
      const dd = path.join(TD, d);
      if (!fs.existsSync(dd)) continue;
      for (const ref of collectRefs(dd)) {
        const pp = resolveRef(ref, dd);
        if (!pp) continue;
        const top = dirOf(pp);
        if (top && !resolved.has(top)) {
          console.log('[td] 闭包补全:', d, '→', ref, '→', top);
          resolved.add(top);
          changed = true;
        }
      }
    }
  }

  // 2) 待裁剪 = 根目录所有条目 - 白名单
  const toTrim = [];
  for (const it of fs.readdirSync(TD)) {
    const full = path.join(TD, it);
    const isDir = fs.statSync(full).isDirectory();
    if (isDir) {
      if (!resolved.has(it)) toTrim.push(it);
    } else {
      if (!KEEP_ROOT_FILES.includes(it)) toTrim.push(it);
    }
  }

  console.log('[td] 保留目录/文件:', [...resolved].sort().join(', '));
  console.log('[td] 待裁剪条目数:', toTrim.length);

  // 3) 自检：保留目录内所有引用目标必须存在（防误删未知依赖）
  const missingRefs = [];
  for (const d of resolved) {
    const dd = path.join(TD, d);
    if (!fs.existsSync(dd)) continue;
    for (const ref of collectRefs(dd)) {
      const pp = resolveRef(ref, dd);
      if (!pp || !pp.startsWith(TD + path.sep)) continue;
      const base = pp.replace(/\.(js|json|wxml|wxss|wxs)$/, '');
      const cands = [pp, base, base + '.js', base + '.json', base + '.wxml', base + '.wxss', base + '.ts', base + '.d.ts', path.join(base, 'index.js')];
      if (!cands.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
        missingRefs.push(`${d} → ${ref} (${path.relative(TD, pp)})`);
      }
    }
  }
  if (missingRefs.length > 0) {
    console.error('[td] ⚠️ 检测到缺失引用，中断裁剪（防误伤）：');
    missingRefs.slice(0, 15).forEach((m) => console.error('   ', m));
    process.exit(1);
  }

  // 4) 移出到备份（可逆）
  fs.mkdirSync(BK, { recursive: true });
  for (const it of toTrim) {
    const src = path.join(TD, it);
    const dst = path.join(BK, it);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    console.log('[td] 移出 →', it);
  }

  const after = dirSize(TD);
  console.log('\n[td] ✅ 完成');
  console.log('  裁剪前:', (before / 1024).toFixed(1), 'KB');
  console.log('  裁剪后:', (after / 1024).toFixed(1), 'KB');
  console.log('  释放:', ((before - after) / 1024).toFixed(1), 'KB');
  console.log('[td] 备份在 _backup-20260922/tdesign-trimmed/（可逆）');
}

main();