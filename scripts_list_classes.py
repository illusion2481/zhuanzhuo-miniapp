import os, re, glob

ROOT = "E:/WeChatProjects/zhuanzhuo-miniapp/miniprogram"

def scss_classes(path):
    out = []
    with open(path, encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    for m in re.finditer(r"^\s*\.([a-zA-Z_][\w-]*)", src, flags=re.M):
        out.append(m.group(1))
    return out

pages = sorted(glob.glob(os.path.join(ROOT, "pages", "*")))
for pg in pages:
    name = os.path.basename(pg)
    scss_files = glob.glob(os.path.join(pg, "*.scss"))
    if not scss_files:
        continue
    classes = scss_classes(scss_files[0])
    # 去重保序
    seen, uniq = set(), []
    for c in classes:
        if c not in seen:
            seen.add(c); uniq.append(c)
    print(f"\n### {name}  ({len(uniq)} 个类)")
    print("  " + "  ".join(uniq[:60]))
