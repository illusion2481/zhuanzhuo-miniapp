/**
 * 云函数权限校验
 *
 * - getAuthContext: 取当前请求上下文（OPENID/APPID/UNIONID），并附 OPENID 哈希（用于比对）
 * - hashOpenId: sha256(openid).slice(0, 32) —— 与 login 云函数保持同一口径
 * - assertAdminByOpenId: 读 ADMIN_OPENID_HASHES 环境变量（逗号分隔），判断当前用户是否管理员
 * - assertAdmin: 接收已确定 role 的版本，保留向后兼容
 */

export interface AuthContext {
  openId: string;
  /** sha256(openId).slice(0,32)，与 users.open_id_hash 同口径 */
  openIdHash: string;
  appId: string;
  unionId?: string;
}

function loadCrypto() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('crypto');
}

export function hashOpenId(openId: string): string {
  if (!openId) return '';
  return loadCrypto().createHash('sha256').update(String(openId)).digest('hex').slice(0, 32);
}

export function getAuthContext(): AuthContext {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cloud = require('wx-server-sdk');
  const wxContext = cloud.getWXContext();
  const openId: string = (wxContext && wxContext.OPENID) || '';
  return {
    openId,
    openIdHash: hashOpenId(openId),
    appId: (wxContext && wxContext.APPID) || '',
    unionId: wxContext && wxContext.UNIONID,
  };
}

/** 读环境变量中的管理员 OPENID 哈希列表；未配置返回空数组 */
export function listAdminOpenIdHashes(): string[] {
  return String(process.env.ADMIN_OPENID_HASHES || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

/**
 * 判断并断言当前用户是管理员。
 * - 环境变量未配置：抛 ADMIN_NOT_CONFIGURED（防误用：永远不绕过）
 * - 不在列表：抛 FORBIDDEN
 * - 在列表：通过
 */
export function assertAdminByOpenId(openId?: string, openIdHash?: string): void {
  const adminHashes = listAdminOpenIdHashes();
  if (!adminHashes.length) {
    const err = new Error(
      '管理员白名单未配置（缺少环境变量 ADMIN_OPENID_HASHES）',
    ) as Error & { code?: string };
    err.code = 'ADMIN_NOT_CONFIGURED';
    throw err;
  }
  const myHash = openIdHash || hashOpenId(openId || '');
  if (!myHash || !adminHashes.includes(myHash)) {
    const err = new Error('无管理员权限') as Error & { code?: string };
    err.code = 'FORBIDDEN';
    throw err;
  }
}

/**
 * 旧接口：接收 role 字段（不推荐 —— 仅在已查库得到 role 时使用）
 * 保留以兼容早期调用；新代码请用 assertAdminByOpenId
 */
export function assertAdmin(role?: string): void {
  if (role !== 'admin') {
    const err = new Error('无管理员权限') as Error & { code?: string };
    err.code = 'FORBIDDEN';
    throw err;
  }
}