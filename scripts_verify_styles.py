import os, re, glob

ROOT = "E:/WeChatProjects/zhuanzhuo-miniapp/miniprogram"

# 提取 scss 中的类名选择器（顶层 .class，不含伪类/组合）
def scss_classes(path):
    out = set()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    # 去掉注释
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    for m in re.finditer(r"\.([a-zA-Z_][\w-]*)", src):
        out.add(m.group(1))
    return out

# 提取 wxml 中 class="..." 用到的所有类名
def wxml_classes(path):
    out = set()
    with open(path, encoding="utf-8") as f:
        src = f.read()
    for m in re.finditer(r'class\s*=\s*"([^"]*)"', src):
        for tok in m.group(1).split():
            # 去掉 modifier 前缀（如 avatar--guest 取 avatar 也保留完整）
            out.add(tok)
            base = tok.split("--")[0]
            out.add(base)
    return out

# 各页面的"特征类名"——若出现即说明该 scss 混入了别的页面内容
MARKERS = {
    "profile": {"profile-card", "avatar", "credit-card", "link-row", "profile-name", "profile-role"},
    "study":   {"timer-block", "timer-value", "chart-block", "recent-item", "ai-summary", "stat-card", "goal-input"},
    "home":    {"hero-card", "ai-grid", "header-title", "plan-submit", "page-title"},
    "rooms":   {"box-room", "venue", "page-bg", "room-bg"},
    "seats":   {"seat-grid", "seat-cell", "time-row"},
    "reservation": {"reserve", "plan-form", "plan-submit", "time-slot"},
    "myReservations": {"resv-item", "resv-card", "tab-row", "tab-chip"},
    "checkin": {"checkin-card", "checkin-"},
    "admin":   {"admin-", "stat-", "table-"},
}

pages = sorted(glob.glob(os.path.join(ROOT, "pages", "*")))
print("="*70)
print("页面样式交叉验证报告")
print("="*70)
problems = []
for pg in pages:
    name = os.path.basename(pg)
    scss_files = glob.glob(os.path.join(pg, "*.scss"))
    wxml_files = glob.glob(os.path.join(pg, "*.wxml"))
    if not scss_files or not wxml_files:
        continue
    scss = scss_classes(scss_files[0])
    wxml = wxml_classes(wxml_files[0])

    # 1) WXML 用到但 SCSS 没定义的（本页样式缺失）
    missing = sorted(wxml - scss)
    # 过滤掉通用 token（page / page-title / page-subtitle 等由 app.scss 提供）
    COMMON = {"page", "page-title", "page-subtitle", "section", "section-title", "list-in",
              "loading-state", "error-state", "empty-state"}
    missing_real = [c for c in missing if c not in COMMON and not c.startswith("t-")]

    # 2) 本页 scss 是否混入其它页面特征类
    foreign = []
    for other, marks in MARKERS.items():
        if other == name:
            continue
        hits = sorted(marks & scss)
        if hits:
            foreign.append((other, hits))

    flag = "❌" if (missing_real or foreign) else "✅"
    print(f"\n[{flag}] {name}")
    if missing_real:
        print(f"   WXML缺样式(本页未定义): {missing_real[:20]}")
        problems.append((name, "缺样式", missing_real[:20]))
    if foreign:
        for other, hits in foreign:
            print(f"   ⚠ 混入[{other}]特征类: {hits}")
            problems.append((name, f"混入{other}样式", hits))

if not problems:
    print("\n未发现样式串文件/缺失问题")
else:
    print(f"\n共发现 {len(problems)} 处异常")
