import { describe, it, expect } from 'vitest';
import { describeFetchError, isTimeoutError } from '@/engine/net-errors';

describe('describeFetchError', () => {
  it('展开多层 cause 链并去重', () => {
    const err = new TypeError('fetch failed', {
      cause: new Error('Request was cancelled.', {
        cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
      }),
    });

    expect(describeFetchError(err).message)
      .toBe('fetch failed: Request was cancelled.: Proxy response (407) !== 200 when HTTP Tunneling');
  });

  it('相同消息不重复拼接', () => {
    const err = new Error('boom', { cause: new Error('boom') });
    expect(describeFetchError(err).message).toBe('boom');
  });

  it('纯超时 error 统一为 Fetch timeout', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(describeFetchError(timeout).message).toBe('Fetch timeout');
  });

  it('非 Error 输入转字符串', () => {
    expect(describeFetchError('oops').message).toBe('oops');
  });

  it('isTimeoutError 识别 AbortError / TimeoutError', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTimeoutError(abort)).toBe(true);

    const timeout = new Error('timeout');
    timeout.name = 'TimeoutError';
    expect(isTimeoutError(timeout)).toBe(true);

    expect(isTimeoutError(new Error('other'))).toBe(false);
  });
});
