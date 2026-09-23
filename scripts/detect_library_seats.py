"""用投影法精确检测图书馆桌面的行列中心（健壮版）。

1) 像素级桌面掩膜（比地板亮、非窗/书架/入口区）
2) 纵向投影 → 桌面"行"的 y 中心
3) 横向投影分左右两区 → 各自"列"的 x 中心
4) 输出可直接写入 floorPlans.ts 的坐标数组
"""
from PIL import Image

IMG = "miniprogram/assets/seats/library-floorplan.jpg"
im = Image.open(IMG).convert("RGB")
W, H = im.size
scale = 700.0 / W if W > 700 else 1.0
iw, ih = int(W * scale), int(H * scale)
im = im.resize((iw, ih))
px = im.load()


def is_desk(r, g, b, nx, ny):
    if ny < 0.27 or nx < 0.06 or ny > 0.86:
        return False
    bright = r + g + b
    if bright < 430:
        return False
    cream = r > 180 and g > 170 and b > 150 and (max(r, g, b) - min(r, g, b)) < 60
    wood = r > 165 and g > 130 and b > 95 and r >= g >= b and bright < 640
    return cream or wood


mask = [[0] * iw for _ in range(ih)]
for y in range(ih):
    for x in range(iw):
        r, g, b = px[x, y]
        mask[y][x] = 1 if is_desk(r, g, b, x / iw, y / ih) else 0

rowsum = [sum(mask[y]) for y in range(ih)]
colsumL = [sum(mask[y][x] for y in range(ih)) for x in range(iw // 2)]
colsumR = [sum(mask[y][x] for y in range(ih)) for x in range(iw // 2, iw)]


def find_peaks(arr, merge_gap_frac):
    """返回局部极大值位置（像素索引），并把间距 < merge_gap_frac*len 的合并。"""
    n = len(arr)
    thr = max(arr) * 0.30 if max(arr) > 0 else 0
    raw = []
    for i in range(n):
        if arr[i] < thr:
            continue
        ok = all(arr[i] >= arr[j] for j in range(max(0, i - 2), min(n, i + 3)) if j != i)
        if ok:
            raw.append(i)
    # 合并过近峰
    merged = []
    min_gap = n * merge_gap_frac
    for p in raw:
        if merged and (p - merged[-1]) < min_gap:
            merged[-1] = int((merged[-1] + p) / 2)
        else:
            merged.append(p)
    return merged


row_peaks = find_peaks(rowsum, 0.05)
col_peaksL = find_peaks(colsumL, 0.035)
col_peaksR = [iw // 2 + p for p in find_peaks(colsumR, 0.035)]

row_y = [round((p + 0.5) / ih * 100, 1) for p in row_peaks]
col_xL = [round((p + 0.5) / iw * 100, 1) for p in col_peaksL]
col_xR = [round((p + 0.5) / iw * 100, 1) for p in col_peaksR]

# 生成坐标数组
positions = []
seat_no = 0
for ri, y in enumerate(row_y, 1):
    for ci, x in enumerate(col_xL, 1):
        seat_no += 1
        positions.append((seat_no, ri, ci, x, y))
base = len(col_xL)
for ri, y in enumerate(row_y, 1):
    for ci, x in enumerate(col_xR, 1):
        seat_no += 1
        positions.append((seat_no, ri, base + ci, x, y))

print(f"# 图像 {W}x{H} → 降采样 {iw}x{ih}")
print(f"# 行数: {len(row_y)}  y={row_y}")
print(f"# 左区列数: {len(col_xL)}  x={col_xL}")
print(f"# 右区列数: {len(col_xR)}  x={col_xR}")
print(f"# 总座位数: {seat_no}")
print()
print("const LIB_POSITIONS: [number, number][] = [")
for s in positions:
    print("  [%.1f, %.1f],  // #%d row%d col%d" % (s[3], s[4], s[0], s[1], s[2]))
print("];")
