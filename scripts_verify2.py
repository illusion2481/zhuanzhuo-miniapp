import os, re, glob

ROOT = "E:/WeChatProjects/zhuanzhuo-miniapp/miniprogram"

def scss_classes(path):
    out = set()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    for m in re.finditer(r"\.([a-zA-Z_][\w-]*)", src):
        out.add(m.group(1))
    return out

def wxml_literal_classes(path):
    """只取字面值类名，忽略含 {{ 或三元表达式的 token"""
    out = set()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    for m in re.finditer(r'class\s*=\s*"([^"]*)"', src):
        for tok in m.group(1).split():
            if "{{" in tok or "?" in tok or tok in ("''}}", "}}", ":", "==="):
                continue
            out.add(tok)
            base = tok.split("--")[0]
            out.add(base)
    return out

# 全局共享类（出现在多个 scss 中）
global_set = {}
for pg in glob.glob(os.path.join(ROOT, "pages", "*")):
    scss_files = glob.glob(os.path.join(pg, "*.scss"))
    if not scss_files: continue
    for c in scss_classes(scss_files[0]):
        global_set.setdefault(c, set()).add(os.path.basename(pg))
shared = {c for c, ps in global_set.items() if len(ps) > 1}

COMMON = {"page", "page-title", "page-subtitle", "section", "section-title",
          "list-in", "loading-state", "error-state", "empty-state", "btn",
          "btn--primary", "btn--ghost", "btn--danger", "flex-between"}

print("="*60)
print("精确交叉验证（仅字面类名，忽略动态表达式）")
print("="*60)
issues = 0
for pg in sorted(glob.glob(os.path.join(ROOT, "pages", "*"))):
    name = os.path.basename(pg)
    scss_files = glob.glob(os.path.join(pg, "*.scss"))
    wxml_files = glob.glob(os.path.join(pg, "*.wxml"))
    if not scss_files or not wxml_files: continue
    scss = scss_classes(scss_files[0])
    wxml = wxml_literal_classes(wxml_files[0])
    missing = sorted(wxml - scss - shared - COMMON - {"t-button"})
    if missing:
        print(f"\n[⚠] {name} 缺样式: {missing}")
        issues += 1
    else:
        print(f"[✅] {name} 字面类名全部有样式")
print(f"\n真实缺失: {issues} 页")
