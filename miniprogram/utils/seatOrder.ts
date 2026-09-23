/**
 * 座位顺序：一律按「编号升序」（A-1 → A-2 → … → A-13）。
 *
 * 为什么不用 row/col 排序：
 * row/col 是管理员批量新增时由云端推算出来的坐标，新增座位会带着自己的坐标插进中间，
 * 导致座位图出现 A-1…A-9、A-13、A-10 这种乱序。用户要的是「永远 1、2、3… 递增，
 * 新增的接在最后，删除中间的不打乱其余顺序」——只有按编号升序能保证。
 *
 * 后台座位格（admin）与用户端座位图（SeatMap）**共用本函数**，
 * 保证两处展示顺序口径一致；改这里两边同时生效。
 */

interface SeatOrderKey {
  prefix: string;
  no: number;
}

/**
 * 拆出「前缀 + 末尾数字」：'A-13' → { prefix: 'A-', no: 13 }
 * 完全无数字的编号排最后（用 MAX_SAFE_INTEGER），避免被排到最前面。
 */
function seatOrderKey(seatId?: string): SeatOrderKey {
  const s = String(seatId || '');
  const m = s.match(/^(.*?)(\d+)\s*$/);
  if (!m) return { prefix: s.toUpperCase(), no: Number.MAX_SAFE_INTEGER };
  return { prefix: String(m[1] || '').toUpperCase(), no: Number(m[2]) };
}

/**
 * 按编号升序排序（不修改入参，返回新数组）。
 * 同房间混有多个前缀时，先按前缀字母排（A 在前、B 在后），再比编号。
 */
export function sortSeatsByNumber<T extends { seat_id?: string }>(list: T[] | null | undefined): T[] {
  if (!Array.isArray(list)) return [];
  return list.slice().sort((a, b) => {
    const ka = seatOrderKey(a && a.seat_id);
    const kb = seatOrderKey(b && b.seat_id);
    // 前缀不同 → 前缀字母优先（A-1 排在 B-1 前面）
    if (ka.prefix !== kb.prefix) return ka.prefix.localeCompare(kb.prefix);
    // 同前缀 → 数字升序（A-2 排在 A-10 前面，不能用字符串比）
    if (ka.no !== kb.no) return ka.no - kb.no;
    // 兜底：完全同号时按全字符串稳定排序，保证顺序可预期
    return String(a && a.seat_id).localeCompare(String(b && b.seat_id));
  });
}

/**
 * 座位编号「体检」：判断是否需要补正 —— **存在缺号** 或 **仍是旧格式**（A-001 带前导零）。
 *
 * 用途：管理端进座位页时自动兜底。若发现当前房间编号有洞
 * （例：A-1…A-11、A-13、A-14 缺 A-12），自动调云端 renumberSeats 补成 A-1…A-13，
 * 用户不必手动找按钮。只有确实有问题才返回 true，正常房间不会触发任何写操作。
 *
 * 判定「正常」= 每个前缀内按数字升序后，第 k 个座位的 seat_id 恰好是「前缀 + (k+1)」。
 * 不带数字的编号不参与判定（无法推断它的序号，不动它）。
 */
export function needsSeatRenumber<T extends { seat_id?: string }>(
  list: T[] | null | undefined,
): boolean {
  if (!Array.isArray(list) || list.length < 2) return false;
  const groups = new Map<string, Array<{ no: number; id: string }>>();
  list.forEach((s) => {
    const id = String((s && s.seat_id) || '');
    const m = id.match(/^(.*?)(\d+)\s*$/);
    if (!m) return;
    const prefix = String(m[1] || '');
    const no = Number(m[2]);
    if (!Number.isFinite(no) || no <= 0) return;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push({ no, id });
  });
  for (const [prefix, items] of groups) {
    items.sort((a, b) => a.no - b.no);
    for (let k = 0; k < items.length; k += 1) {
      // 编号必须是「前缀 + 自然数」且连续：A-1、A-2…（A-001 或跳号都会在这里被判为需要补正）
      if (items[k].id !== `${prefix}${k + 1}`) return true;
    }
  }
  return false;
}
