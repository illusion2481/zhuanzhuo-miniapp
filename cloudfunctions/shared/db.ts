/**
 * 云数据库初始化（云函数侧）
 * 正式部署时使用 wx-server-sdk
 */

// wx-server-sdk 类型在云函数部署环境提供；本地以 unknown 承接
let db: unknown = null;

export function getDb(): unknown {
  if (db) return db;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cloud = require('wx-server-sdk') as {
    init: (opts: { env: unknown }) => void;
    DYNAMIC_CURRENT_ENV: unknown;
    database: () => unknown;
  };
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  db = cloud.database();
  return db;
}

export const COLLECTIONS = {
  CATEGORIES: 'categories',
  RECORDS: 'records',
  USERS: 'users',
} as const;

/** 分页拉全量（与 db.js 同步）：基于 _id 游标循环，避免单次 limit 截断 */
export async function fetchAllPaged(
  collectionName: string,
  where: Record<string, unknown>,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<unknown[]> {
  const d = getDb() as {
    command: { gt: (v: unknown) => unknown; and: (...args: unknown[]) => unknown };
    collection: (name: string) => {
      where: (cond: unknown) => {
        orderBy: (field: string, dir: string) => { limit: (n: number) => { get: () => Promise<{ data?: unknown[] }> } };
      };
    };
  };
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 1000);
  const maxPages = options.maxPages || 100;
  const out: unknown[] = [];
  let cursor: unknown = null;
  for (let i = 0; i < maxPages; i++) {
    const cond = cursor ? d.command.and(where, { _id: d.command.gt(cursor) }) : where;
    const res = await d
      .collection(collectionName)
      .where(cond)
      .orderBy('_id', 'asc')
      .limit(pageSize)
      .get();
    const rows = (res && res.data) || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    cursor = (rows[rows.length - 1] as { _id?: unknown })._id;
  }
  return out;
}
