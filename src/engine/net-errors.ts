/**
 * 网络错误描述：把 fetch/undici 的多层 cause 链展开成一条可读消息。
 *
 * 背景（v2.44.0）：代理 407 的真实原因藏在第 3 层 cause：
 *   TypeError: fetch failed
 *     └─ Error: Request was cancelled.
 *          └─ AbortError: Proxy response (407) !== 200 when HTTP Tunneling
 * 旧实现只解一层，管理界面只看到「Request was cancelled.」，极难定位。
 */

const MAX_CAUSE_DEPTH = 6;

/** 递归展开 Error.cause，去重后拼接为 `a: b: c` */
export function describeFetchError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));

  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const text = (current.message || current.name || '').trim();
    if (text && !messages.includes(text)) messages.push(text);
    current = (current as Error & { cause?: unknown }).cause;
  }

  // 纯超时（没有更深的 cause）统一成简短文案；有 cause 时保留完整链路
  if (messages.length <= 1) {
    const name = err.name;
    if (name === 'AbortError' || name === 'TimeoutError') return new Error('Fetch timeout');
  }

  return new Error(messages.join(': ') || String(err));
}

/** 是否为超时类错误（用于避免「超时后再回退」把等待时间翻倍） */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}
