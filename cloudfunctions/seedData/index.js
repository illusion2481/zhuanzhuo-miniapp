const cloud = require('wx-server-sdk')
const { categories, demoRecords, COLLECTIONS } = require('./seedPayload')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 入参白名单（F7） */
const SCHEMA = {
  includeDemoRecords: { type: 'boolean', optional: true },
  resetCategories: { type: 'boolean', optional: true },
  resetRecords: { type: 'boolean', optional: true },
}

function ok(data, message) {
  return {
    success: true,
    data,
    message: message || '操作成功',
    request_id: 'req_' + Date.now(),
  }
}

function fail(message, data) {
  return {
    success: false,
    data: data || null,
    message,
    request_id: 'req_' + Date.now(),
  }
}

/**
 * 按 _id upsert 文档
 * @param {string} collection
 * @param {Array<{_id: string}>} docs
 * @param {boolean} reset 为 true 时先清空集合再写入（危险，仅演示环境）
 */
async function upsertDocs(collection, docs, reset) {
  const col = db.collection(collection)
  let cleared = 0
  let written = 0
  let skipped = 0

  if (reset) {
    // 云数据库单次最多删 20 条，循环清理
    for (let i = 0; i < 50; i++) {
      const batch = await col.limit(20).get()
      if (!batch.data.length) break
      await Promise.all(batch.data.map((doc) => col.doc(doc._id).remove()))
      cleared += batch.data.length
    }
  }

  for (const doc of docs) {
    const { _id, ...rest } = doc
    try {
      await col.doc(_id).set({
        data: rest,
      })
      written += 1
    } catch (err) {
      try {
        const exists = await col.doc(_id).get()
        if (exists.data && Object.keys(exists.data).length) {
          await col.doc(_id).update({ data: rest })
        } else {
          await col.add({ data: doc })
        }
        written += 1
      } catch (err2) {
        skipped += 1
        console.error('[seedData] write fail', collection, _id, err2)
      }
    }
  }

  return { cleared, written, skipped, total: docs.length }
}

/**
 * event.resetCategories / event.resetRecords / event.includeDemoRecords
 */
exports.main = async (event = {}) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const v = check.value
    const includeDemoRecords = v.includeDemoRecords !== false
    const resetCategories = !!v.resetCategories
    const resetRecords = !!v.resetRecords

    const categoryResult = await upsertDocs(
      COLLECTIONS.CATEGORIES,
      categories,
      resetCategories,
    )

    let recordResult = { cleared: 0, written: 0, skipped: 0, total: 0 }
    if (includeDemoRecords) {
      recordResult = await upsertDocs(COLLECTIONS.RECORDS, demoRecords, resetRecords)
    }

    return ok(
      {
        categories: categoryResult,
        records: recordResult,
        hints: [
          '请在云开发控制台确认已创建 categories / records / users 集合',
          '建议按 docs/database.md 创建复合索引',
          'users 集合由 login 云函数按需创建用户文档',
        ],
      },
      '种子数据写入完成',
    )
  } catch (err) {
    return fail((err && err.message) || '种子数据写入失败')
  }
}
