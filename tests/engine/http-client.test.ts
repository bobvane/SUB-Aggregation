import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent, ProxyAgent } from 'undici';
import {
  createHttpClient,
  resetHttpAgents,
  describeProxyDecision,
  DEFAULT_TIMEOUT_MS,
} from '@/engine/http-client';
import { SUBSCRIPTION_FETCH_TIMEOUT_MS } from '@/engine/fetcher';
import { PROXY_PROBE_TIMEOUT_MS, type SettingsReader } from '@/engine/proxy-config';

const settings = (entries: Record<string, string>): SettingsReader => ({
  get: async (key) => entries[key] ?? null,
});

type Captured = { url: string; init: RequestInit & { dispatcher?: unknown } };

const PROXY_URL = 'http://127.0.0.1:7890';

/** 构造三态配置：不传的目标默认 auto */
function targets(overrides: Record<string, 'auto' | 'on' | 'off'> = {}): string {
  const all: Record<string, string> = {
    subscription: 'auto', rules: 'auto', version: 'auto', dns: 'auto', geo: 'auto',
    ...overrides,
  };
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join(',');
}

const withProxy = (overrides: Record<string, 'auto' | 'on' | 'off'> = {}) => settings({
  proxy_url: PROXY_URL,
  proxy_targets: targets(overrides),
});

function capture() {
  const calls: Captured[] = [];
  const rawFetch = async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
    return new Response('ok');
  };
  return { calls, rawFetch };
}

const isProxyAgent = (c: Captured) => c.init.dispatcher instanceof ProxyAgent;
const isDirectAgent = (c: Captured) => c.init.dispatcher instanceof Agent && !isProxyAgent(c);

beforeEach(() => {
  resetHttpAgents();
});

describe('三态策略', () => {
  it('on：直接走代理，不试直连', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(withProxy({ subscription: 'on' }), { rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(isProxyAgent(calls[0])).toBe(true);
  });

  it('off：即使配了代理也只直连', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(withProxy({ subscription: 'off' }), { rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(isDirectAgent(calls[0])).toBe(true);
  });

  it('auto：直连成功就不碰代理（只发一次请求）', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(withProxy({ subscription: 'auto' }), { rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(isDirectAgent(calls[0])).toBe(true);
  });

  it('auto：直连失败后改用代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        if (calls.length === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(2);
    expect(isDirectAgent(calls[0])).toBe(true);
    expect(isProxyAgent(calls[1])).toBe(true);
  });

  it('auto：两条路都失败时报错里能分辨两段原因', async () => {
    let calls = 0;
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      rawFetch: async () => {
        calls++;
        throw new TypeError('fetch failed', {
          cause: calls === 1 ? new Error('ECONNREFUSED') : new Error('proxy 407'),
        });
      },
    });

    await expect(client.fetch('subscription', 'https://example.com/sub'))
      .rejects.toThrow(/直连失败[\s\S]*代理也失败/);
    expect(calls).toBe(2);
  });

  it('每项目标互相独立：订阅直连、规则目录走代理', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(withProxy({ subscription: 'off', rules: 'on' }), { rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    await client.fetch('rules', 'https://api.github.com/repos');
    expect(isDirectAgent(calls[0])).toBe(true);
    expect(isProxyAgent(calls[1])).toBe(true);
  });
});

describe('bypass 一票否决', () => {
  it('命中 bypass 时，即使目标设为 on 也直连', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(withProxy({ subscription: 'on' }), { rawFetch });

    await client.fetch('subscription', 'http://127.0.0.1:9000/sub');
    expect(calls).toHaveLength(1);
    expect(isDirectAgent(calls[0])).toBe(true);
  });

  it('命中 bypass 且直连失败时报错，不会偷偷改走代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });

    await expect(client.fetch('subscription', 'http://192.168.2.10/sub'))
      .rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toHaveLength(1);
    expect(isDirectAgent(calls[0])).toBe(true);
  });

  it('自定义 bypass 生效', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(settings({
      proxy_url: PROXY_URL,
      proxy_targets: targets({ subscription: 'on' }),
      proxy_bypass: 'corp.example.com',
    }), { rawFetch });

    await client.fetch('subscription', 'https://api.corp.example.com/sub');
    expect(isDirectAgent(calls[0])).toBe(true);
  });
});

describe('未配置代理地址', () => {
  it('地址留空时全部直连，即使目标设为 on', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(settings({ proxy_targets: targets({ subscription: 'on' }) }), { rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(isDirectAgent(calls[0])).toBe(true);
  });
});

describe('auto 的 3 秒探测', () => {
  it('默认探测时限为 3 秒', () => {
    expect(PROXY_PROBE_TIMEOUT_MS).toBe(3_000);
  });

  it('探测超时后改用代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      probeTimeoutMs: 10,
      rawFetch: (url, init) => {
        const i = (init ?? {}) as Captured['init'];
        calls.push({ url: String(url), init: i });
        if (i.dispatcher instanceof ProxyAgent) return Promise.resolve(new Response('ok'));
        // 直连：永远不返回，等探测超时把它中止
        return new Promise((_resolve, reject) => {
          i.signal?.addEventListener('abort', () => reject(new Error('probe timeout')));
        });
      },
    });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(2);
    expect(isProxyAgent(calls[1])).toBe(true);
  });

  it('拿到响应头后停止探测计时，响应体不会被 3 秒打断', async () => {
    let capturedSignal: AbortSignal | undefined;
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      probeTimeoutMs: 10,
      rawFetch: async (_url, init) => {
        capturedSignal = (init as RequestInit)?.signal ?? undefined;
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'https://example.com/sub');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('调用方主动取消时不再改试代理', async () => {
    let calls = 0;
    const controller = new AbortController();
    const client = createHttpClient(withProxy({ subscription: 'auto' }), {
      probeTimeoutMs: 10,
      rawFetch: async () => {
        calls++;
        if (calls === 1) {
          controller.abort();
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return new Response('ok');
      },
    });

    await expect(client.fetch('subscription', 'https://example.com/sub', { signal: controller.signal }))
      .rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('测试代理按钮', () => {
  it('未配置地址时返回 via=none', async () => {
    const client = createHttpClient(settings({}), { rawFetch: async () => new Response('ok') });
    const result = await client.testProxy();
    expect(result.ok).toBe(false);
    expect(result.via).toBe('none');
  });

  it('永远走代理，不受目标策略影响', async () => {
    const { calls, rawFetch } = capture();
    // 全部设为 off 也不影响「测试代理」——它是用来验证代理本身的
    const client = createHttpClient(withProxy({ version: 'off', rules: 'off' }), { rawFetch });
    const result = await client.testProxy();
    expect(calls).toHaveLength(1);
    expect(isProxyAgent(calls[0])).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.via).toBe('proxy');
  });

  it('代理失败时返回错误信息而不是抛出', async () => {
    const client = createHttpClient(withProxy(), {
      rawFetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });
    const result = await client.testProxy();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('配置读取与常量', () => {
  it('环境变量不再影响代理选择', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://env-proxy:8080');
    const { calls, rawFetch } = capture();
    const client = createHttpClient(settings({}), { rawFetch });

    await client.fetch('rules', 'https://api.github.com/');
    expect(isDirectAgent(calls[0])).toBe(true);
    vi.unstubAllEnvs();
  });

  it('从未保存 proxy_targets 时 5 项全部按 auto 处理', async () => {
    const decision = await describeProxyDecision(
      settings({ proxy_url: PROXY_URL }),
      'subscription',
      'https://example.com/sub'
    );
    expect(decision.mode).toBe('auto');
    expect(decision.probeDirect).toBe(true);
  });

  it('describeProxyDecision 反映 bypass 与 off', async () => {
    const bypassed = await describeProxyDecision(
      settings({ proxy_url: PROXY_URL, proxy_targets: targets({ subscription: 'on' }) }),
      'subscription',
      'http://10.0.0.5/sub'
    );
    expect(bypassed.bypassed).toBe(true);
    expect(bypassed.proxyUrl).toBeNull();

    const off = await describeProxyDecision(
      settings({ proxy_url: PROXY_URL, proxy_targets: targets({ subscription: 'off' }) }),
      'subscription',
      'https://example.com/sub'
    );
    expect(off.proxyUrl).toBeNull();
    expect(off.probeDirect).toBe(false);
  });

  it('各目标默认超时', () => {
    expect(SUBSCRIPTION_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_TIMEOUT_MS.subscription).toBe(SUBSCRIPTION_FETCH_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS.rules).toBe(15_000);
    expect(DEFAULT_TIMEOUT_MS.version).toBe(15_000);
    expect(DEFAULT_TIMEOUT_MS.dns).toBe(5_000);
    expect(DEFAULT_TIMEOUT_MS.geo).toBe(10_000);
  });
});

describe('超时注入', () => {
  it('注入的 signal 会在超时后中止', async () => {
    let signal: AbortSignal | undefined;
    const client = createHttpClient(settings({}), {
      rawFetch: async (_url, init) => {
        signal = (init as RequestInit)?.signal ?? undefined;
        return new Response('ok');
      },
    });

    await client.fetch('geo', 'https://example.com/geo', { timeoutMs: 5 });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal?.aborted).toBe(true);
  });
});
