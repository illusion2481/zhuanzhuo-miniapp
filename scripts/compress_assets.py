"""压缩小程序主包内的大图（原图已备份到 scripts/assets-backup/）"""
import os
from PIL import Image

MP = r"E:\WeChatProjects\zhuanzhuo-miniapp\miniprogram\assets"

def compress_jpg(path, max_w=1080, quality=72):
    im = Image.open(path)
    orig = im.size
    if im.mode != "RGB":
        im = im.convert("RGB")
    if im.width > max_w:
        h = round(im.height * max_w / im.width)
        im = im.resize((max_w, h), Image.LANCZOS)
    im.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    return orig, os.path.getsize(path) / 1024

def compress_png(path, max_w=1080):
    im = Image.open(path)
    orig = im.size
    has_alpha = im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 255
    if im.width > max_w:
        h = round(im.height * max_w / im.width)
        im = im.resize((max_w, h), Image.LANCZOS)
    if has_alpha:
        im = im.quantize(colors=256, method=Image.FASTOCTREE)
        im.save(path, "PNG", optimize=True)
    else:
        im.convert("RGB").save(path, "JPEG", quality=72, optimize=True, progressive=True)
        if os.path.exists(path):
            # 保持原扩展名：png 不能直接存 jpeg 内容，改为量化 PNG
            pass
    return orig, os.path.getsize(path) / 1024

report = []
for name in ["seats/library-v2.jpg", "seats/classroom.jpg", "seats/coffee-corner.jpg"]:
    p = os.path.join(MP, name.replace("/", os.sep))
    before = os.path.getsize(p) / 1024
    orig, after = compress_jpg(p)
    report.append(f"{name}: {before:.0f}KB -> {after:.0f}KB  size={orig}->{Image.open(p).size}")

# rooms-bg.png 单独处理（保留 alpha 量化；无 alpha 则转 256 色仍可）
p = os.path.join(MP, "icons", "rooms-bg.png")
before = os.path.getsize(p) / 1024
im = Image.open(p)
has_alpha = im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 255
if im.width > 1080:
    im = im.resize((1080, round(im.height * 1080 / im.width)), Image.LANCZOS)
if has_alpha:
    im = im.quantize(colors=256, method=Image.FASTOCTREE)
    im.save(p, "PNG", optimize=True)
else:
    im.convert("P", palette=Image.ADAPTIVE, colors=256).save(p, "PNG", optimize=True)
report.append(f"icons/rooms-bg.png: {before:.0f}KB -> {os.path.getsize(p)/1024:.0f}KB  alpha={has_alpha} size={Image.open(p).size}")

print("\n".join(report))
