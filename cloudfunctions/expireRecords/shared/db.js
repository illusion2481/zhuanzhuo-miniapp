let db = null

function getDb() {
  if (db) return db
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  db = cloud.database()
  return db
}

const COLLECTIONS = {
  CATEGORIES: 'categories',
  RECORDS: 'records',
  USERS: 'users',
}

/**
 * 分页拉全量（F5/F6）：基于 _id 游标循环，避免单次 limit 截断导致统计/清理漏数。
 * 适用于定时任务与统计聚合（单页 ≤1000、默认最多 100 页）；
 * 数据量极大时应改用聚合管道，而非此处循环。
 *
 * @param {string} collectionName 集合名
 * @param {object} where 查询条件（可使用 db.command 表达式）
 * @param {{pageSize?: number, maxPages?: number}} options
 */
async function fetchAllPaged(collectionName, where, options = {}) {
  const d = getDb()
  const _ = d.command
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 1000)
  const maxPages = options.maxPages || 100
  const out = []
  let cursor = null
  for (let i = 0; i < maxPages; i++) {
    const cond = cursor ? _.and(where, { _id: _.gt(cursor) }) : where
    const res = await d
      .collection(collectionName)
      .where(cond)
      .orderBy('_id', 'asc')
      .limit(pageSize)
      .get()
    const rows = (res && res.data) || []
    out.push(...rows)
    if (rows.length < pageSize) break
    cursor = rows[rows.length - 1]._id
  }
  return out
}

module.exports = { getDb, COLLECTIONS, fetchAllPaged }
