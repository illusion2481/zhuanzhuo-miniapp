/**
 * 座位中文命名工具
 * - 机器码 seat_id（如 A-001）保持不变，供预约冲突检测 / 二维码校验使用
 * - 这里为座位计算一段「用户看得懂」的中文标签，用于座位图 / 详情展示
 */

/** seat_feature code -> 中文名（与 seedData 的 categories 语义一致） */
const FEATURE_NAME: Record<string, string> = {
  quiet: '安静',
  power: '电源',
  window: '靠窗',
};

/** 特征展示优先级（靠窗 > 电源 > 安静） */
const FEATURE_PRIORITY = ['window', 'power', 'quiet'];

/** 座位号首字母 -> 中文区段（映射自习室楼层习惯） */
const ZONE_NAME: Record<string, string> = {
  A: '一楼',
  B: '三楼',
  C: '二楼',
};

/** 判断字符串是否仍是机器码（纯字母数字/连字符，无中文） */
function looksLikeCode(s: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(s);
}

/** 座位特征 code -> 中文名数组（保序、去空） */
export function seatFeatures(features?: string[]): string[] {
  return (features || [])
    .map((c) => FEATURE_NAME[c] || c)
    .filter(Boolean);
}

/** 由 seat_id 首位字母得出中文区段名 */
export function zoneName(seatId: string): string {
  const ch = seatId.charAt(0).toUpperCase();
  return ZONE_NAME[ch] || (ch ? `${ch}区` : '座位');
}

/**
 * 座位展示用中文名。规则：
 * 1) 调用方传的 label 若已是中文，直接用它；
 * 2) 否则用「区段 + 座位号 + 特征」拼一段可读描述。
 */
export function toSeatDisplayName(seat: {
  seat_id: string;
  label?: string;
  features?: string[];
}): string {
  if (seat.label && !looksLikeCode(seat.label)) return seat.label;

  const feats = (seat.features || [])
    .filter((c) => FEATURE_PRIORITY.includes(c))
    .map((c) => FEATURE_NAME[c] || c)
    .join(' ');

  const loc = zoneName(seat.seat_id);
  const suffix = feats ? `·${feats}` : '';
  return `${loc}${seat.seat_id}${suffix}`;
}

/** 预约 / 详情页展示的简短标题（区段 · 座位号） */
export function seatTitle(seatId: string): string {
  const zone = zoneName(seatId);
  return zone ? `${zone} · ${seatId}` : seatId;
}