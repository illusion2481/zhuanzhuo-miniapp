/**
 * 云函数权限校验（运行时版）
 * 与 shared/auth.ts 保持同步。
 */

const crypto = require('crypto')

function hashOpenId(openId) {
  if (!openId) return ''
  return crypto.createHash('sha256').update(String(openId)).digest('hex').slice(0, 32)
}

function getAuthContext() {
  const cloud = require('wx-server-sdk')
  const wxContext = cloud.getWXContext()
  const openId = (wxContext && wxContext.OPENID) || ''
  return {
    openId,
    openIdHash: hashOpenId(openId),
    appId: (wxContext && wxContext.APPID) || '',
    unionId: wxContext && wxContext.UNIONID,
  }
}

function listAdminOpenIdHashes() {
  return String(process.env.ADMIN_OPENID_HASHES || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean)
}

function assertAdminByOpenId(openId, openIdHash) {
  const adminHashes = listAdminOpenIdHashes()
  if (!adminHashes.length) {
    const err = new Error(
      '管理员白名单未配置（缺少环境变量 ADMIN_OPENID_HASHES）',
    )
    err.code = 'ADMIN_NOT_CONFIGURED'
    throw err
  }
  const myHash = openIdHash || hashOpenId(openId || '')
  if (!myHash || !adminHashes.includes(myHash)) {
    const err = new Error('无管理员权限')
    err.code = 'FORBIDDEN'
    throw err
  }
}

function assertAdmin(role) {
  if (role !== 'admin') {
    const err = new Error('无管理员权限')
    err.code = 'FORBIDDEN'
    throw err
  }
}

module.exports = {
  hashOpenId,
  getAuthContext,
  listAdminOpenIdHashes,
  assertAdminByOpenId,
  assertAdmin,
}