/* 告警页处置进度的两个来源（反制授权、处罚交接）按当前账号权限读取（#34）。
   没有对应查看权限的账号（例如只读领导、执行员）不发请求：后台不会因此记一串“查询失败”，
   页面也不把“无权查看”写成“更新失败”，状态只用能读到的事实。只是不去读，后端校验不变。 */

/** 每个来源需要的查看权限，与后端读取接口要求的权限一致。 */
export const PROGRESS_SOURCE_PERMISSION = Object.freeze({ auths: 'disposal:read', handoffs: 'handoff:read' });

/** @param {'auths'|'handoffs'} source @param {(code:string)=>boolean} has 当前账号的权限判断 */
export function canReadProgressSource(source, has) {
  const code = PROGRESS_SOURCE_PERMISSION[source];
  return !!code && typeof has === 'function' && has(code) === true;
}

/**
 * 读一个来源：有权限才请求。结果三种：
 * - { items } 读到了；
 * - { forbidden: true } 没有权限（没发请求，或服务端按 403 拒绝），按“没有可见记录”处理，不算失败；
 * - { failed: true, error } 读取失败，保留上次读到的事实并提示更新失败。
 */
export async function readProgressSource(source, request, has) {
  if (!canReadProgressSource(source, has)) return { forbidden: true };
  try {
    const page = await request();
    return Array.isArray(page?.items) ? { items: page.items } : { failed: true };
  } catch (error) {
    return error?.status === 403 ? { forbidden: true } : { failed: true, error };
  }
}

/** 把一次读取结果并入已记录的来源状态；旧序号的结果不覆盖新结果。 */
export function mergeProgressRead(previous, seq, result) {
  if (previous && previous.seq > seq) return previous;
  if (result?.forbidden) return { seq, items: [], failed: false, forbidden: true };
  if (Array.isArray(result?.items)) return { seq, items: result.items, failed: false };
  return { seq, items: previous?.items, failed: true };
}
