# -*- coding: utf-8 -*-
"""第二轮压缩：把 miniprogram 内图片总量压进 200K（体验评分线）。
seat 三张照片 720px/q55；rooms-bg 再缩；icons jpg 统一 q70。"""
import os
from PIL import Image

ROOT = r"E:\WeChatProjects\zhuanzhuo-miniapp\miniprogram"

JOBS = [
    # (相对路径, 目标最大宽, 保存参数)
    (r"assets\seats\library-v2.jpg", 720, {"quality": 55, "optimize": True}),
    (r"assets\seats\classroom.jpg", 720, {"quality": 55, "optimize": True}),
    (r"assets\seats\coffee-corner.jpg", 720, {"quality": 55, "optimize": True}),
    (r"assets\icons\rooms-bg.png", 96, None),  # PNG：缩到 96px、128 色
]

ICON_DIR = os.path.join(ROOT, r"assets\icons")


def human(n):
    return f"{n/1024:.0f}KB"


report = []
for rel, max_w, kw in JOBS:
    p = os.path.join(ROOT, rel)
    before = os.path.getsize(p)
    im = Image.open(p)
    if rel.endswith(".png"):
        im = im.convert("RGB").resize((max_w, max_w), Image.LANCZOS)
        im = im.quantize(colors=128, method=Image.MEDIANCUT)
        im.save(p, optimize=True)
    else:
        if im.mode != "RGB":
            im = im.convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, int(im.height * max_w / im.width)), Image.LANCZOS)
        im.save(p, **kw)
    after = os.path.getsize(p)
    report.append(f"{rel}: {human(before)} -> {human(after)}")

for name in sorted(os.listdir(ICON_DIR)):
    if not name.lower().endswith(".jpg"):
        continue
    p = os.path.join(ICON_DIR, name)
    before = os.path.getsize(p)
    im = Image.open(p).convert("RGB")
    im.save(p, quality=70, optimize=True)
    after = os.path.getsize(p)
    if after < before:
        report.append(f"icons/{name}: {human(before)} -> {human(after)}")

total = 0
for dirpath, _, files in os.walk(os.path.join(ROOT, "assets")):
    for f in files:
        if f.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
            total += os.path.getsize(os.path.join(dirpath, f))
report.append(f"assets 总计: {human(total)}")
print("\n".join(report))
