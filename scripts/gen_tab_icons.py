# -*- coding: utf-8 -*-
"""生成 tabBar 高清图标（81x81 RGBA 透明 PNG），品牌深绿/灰两套。"""
import os
from PIL import Image, ImageDraw

SIZE = 81
SS = 4  # 超采样倍数，抗锯齿
CANVAS = SIZE * SS

GRAY = (107, 114, 128, 255)      # #6B7280 未选中
GREEN = (27, 67, 50, 255)        # #1B4332 选中
W = 9 * SS                       # 线宽
FILL_ALPHA = 0  # 块面用半透明填充? 复杂，直接纯填充同色

def new_canvas():
    return Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

def draw_home(d, color):
    # 房顶 + 房身，线宽 W，圆角
    # 房子主体
    d.rounded_rectangle([22*SS, 42*SS, 59*SS, 68*SS], radius=6*SS, outline=color, width=W)
    # 屋顶三角
    d.line([(40*SS, 16*SS), (14*SS, 44*SS)], fill=color, width=W)
    d.line([(40*SS, 16*SS), (65*SS, 44*SS)], fill=color, width=W)
    # 门
    d.arc([34*SS, 52*SS, 46*SS, 68*SS], 180, 360, fill=color, width=W)
    # 门上的小把手
    d.ellipse([41*SS, 55*SS, 43*SS, 57*SS], outline=color, width=W)

def draw_rooms(d, color):
    # 4 宫格（选包间）
    for (x0, y0, x1, y1) in [(20*SS,20*SS,39*SS,35*SS),(44*SS,20*SS,63*SS,35*SS),
                             (20*SS,40*SS,39*SS,63*SS),(44*SS,40*SS,63*SS,63*SS)]:
        d.rectangle([x0, y0, x1, y1], outline=color, width=W)

def draw_study(d, color):
    # 番茄钟：圆 + 顶部小苗
    d.ellipse([24*SS, 28*SS, 58*SS, 62*SS], outline=color, width=W)
    # 时针分针
    d.line([(41*SS,40*SS),(41*SS,49*SS)], fill=color, width=W)
    d.line([(41*SS,40*SS),(48*SS,40*SS)], fill=color, width=W)
    # 顶部苗
    d.line([(35*SS,20*SS),(41*SS,30*SS)], fill=color, width=W)
    d.line([(47*SS,20*SS),(41*SS,30*SS)], fill=color, width=W)

def draw_profile(d, color):
    # 人形：头圆 + 肩
    d.ellipse([32*SS, 18*SS, 50*SS, 36*SS], outline=color, width=W)
    # 肩（半圆拱）
    d.arc([22*SS, 38*SS, 60*SS, 78*SS], 200, 340, fill=color, width=W)

ICONS = {
    "home": draw_home,
    "rooms": draw_rooms,
    "study": draw_study,
    "profile": draw_profile,
}

out = os.path.join(os.path.dirname(__file__), "tab")
os.makedirs(out, exist_ok=True)

for name, fn in ICONS.items():
    for suffix, color in (("", GRAY), ("-active", GREEN)):
        img = new_canvas()
        d = ImageDraw.Draw(img)
        fn(d, color)
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
        p = os.path.join(out, f"{name}{suffix}.png")
        img.save(p)
        print("wrote", p)

print("done")