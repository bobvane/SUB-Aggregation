import { describe, it, expect, beforeEach } from 'vitest';
import { Agent, ProxyAgent } from 'undici';
import { createHttpClient, resetHttpAgents, DEFAULT_TIMEOUT_MS } from '@/engine/http-client';
import { SUBSCRIPTION_FETCH_TIMEOUT_MS } from '@/engine/fetcher';
import type { SettingsReader } from '@/engine/proxy-config';

const settings = (entries: Record<string, string>): SettingsReader => ({
  get: async (key) => entries[key] ?? null,
});

type Captured = { url: string; init: RequestInit & { dispatcher?: unknown } };

const manualSettings = settings({
  proxy_mode: 'manual',
  proxy_url: 'http://127.0.0.1:7890',
  proxy_scope: 'subscription,github,geo',
  proxy_fallback: '1',
});

beforeEach(() => {
  resetHttpAgents();
});

describe('http-client 代理选择', () => {
  it('manual + scope 命中时使用 ProxyAgent', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('scope 未命中时直连（DirectAgent）', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(settings({
      proxy_mode: 'manual',
      proxy_url: 'http://127.0.0.1:7890',
      proxy_scope: 'github',
    }), {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
    expect(calls[0].init.dispatcher).not.toBeInstanceOf(ProxyAgent);
  });

  it('bypass 命中时直连', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'http://127.0.0.1:9000/sub');
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
  });

  it('env 模式使用环境变量代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(settings({ proxy_mode: 'env' }), {
      env: { HTTPS_PROXY: 'http://env-proxy:8080' },
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response('ok');
      },
    });

    await client.fetch('github', 'https://api.github.com/');
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });
});

describe('http-client 失败回退', () => {
  it('auto 策略下代理失败会回退直连', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        if (calls.length === 1) {
          throw new TypeError('fetch failed', { cause: new Error('proxy down') });
        }
        return new Response('ok', { status: 200 });
      },
    });

    const res = await client.fetch('subscription', 'https://example.com/sub');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
    expect(calls[1].init.dispatcher).toBeInstanceOf(Agent);
  });

  it('显式 on 不回退，错误包含完整 cause 链', async () => {
    let calls = 0;
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async () => {
        calls++;
        throw new TypeError('fetch failed', {
          cause: new Error('Request was cancelled.', {
            cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling'),
          }),
        });
      },
    });

    await expect(client.fetch('subscription', 'https://example.com/sub', { choice: 'on' }))
      .rejects.toThrow(/Proxy response \(407\)/);
    expect(calls).toBe(1);
  });

  it('显式 off 即使配置了代理也只直连', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response('ok');
      },
    });

    await client.fetch('subscription', 'https://example.com/sub', { choice: 'off' });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
  });

  it('超时不回退（避免等待时间翻倍）', async () => {
    let calls = 0;
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async () => {
        calls++;
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });

    await expect(client.fetch('subscription', 'https://example.com/sub')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('强制 on 但未配置代理时直接报错', async () => {
    const client = createHttpClient(settings({ proxy_mode: 'off' }), {
      env: {},
      rawFetch: async () => new Response('ok'),
    });

    await expect(client.fetch('subscription', 'https://example.com/sub', { choice: 'on' }))
      .rejects.toThrow(/未配置代理地址/);
  });
});

describe('http-client 测试代理', () => {
  it('未配置代理时返回 via=none', async () => {
    const client = createHttpClient(settings({ proxy_mode: 'off' }), {
      env: {},
      rawFetch: async () => new Response('ok'),
    });
    const result = await client.testProxy();
    expect(result.ok).toBe(false);
    expect(result.via).toBe('none');
  });

  it('代理请求成功时返回 ok 与状态码', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        return new Response(null, { status: 204 });
      },
    });

    const result = await client.testProxy();
    expect(result.ok).toBe(true);
    expect(result.status).toBe(204);
    expect(result.via).toBe('proxy');
    expect(calls[0].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('代理失败时返回错误信息而不是抛出', async () => {
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });
    const result = await client.testProxy();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('v2.44.2 订阅默认直连与回退边界', () => {
  const capture = () => {
    const calls: Captured[] = [];
    const rawFetch = async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
      return new Response('ok');
    };
    return { calls, rawFetch };
  };

  it('从未保存 proxy_scope 时订阅抓取直连（默认只代理 github + geo）', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(settings({
      proxy_mode: 'manual',
      proxy_url: 'http://127.0.0.1:7890',
      proxy_fallback: '1',
    }), { env: {}, rawFetch });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
    expect(calls[0].init.dispatcher).not.toBeInstanceOf(ProxyAgent);

    // 同一配置下 GitHub 用途仍应走代理
    await client.fetch('github', 'https://api.github.com/');
    expect(calls[1].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('env 模式默认用途也不含订阅抓取', async () => {
    const { calls, rawFetch } = capture();
    const client = createHttpClient(settings({ proxy_mode: 'env' }), {
      env: { HTTPS_PROXY: 'http://env-proxy:8080' },
      rawFetch,
    });

    await client.fetch('subscription', 'https://example.com/sub');
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
    await client.fetch('github', 'https://api.github.com/');
    expect(calls[1].init.dispatcher).toBeInstanceOf(ProxyAgent);
  });

  it('scope 未命中且直连失败时不再回退代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(settings({
      proxy_mode: 'manual',
      proxy_url: 'http://127.0.0.1:7890',
      proxy_scope: 'github,geo',
      proxy_fallback: '1',
    }), {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });

    await expect(client.fetch('subscription', 'https://example.com/sub'))
      .rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
  });

  it('命中 bypass 且直连失败时不再回退代理', async () => {
    const calls: Captured[] = [];
    const client = createHttpClient(manualSettings, {
      env: {},
      rawFetch: async (url, init) => {
        calls.push({ url: String(url), init: (init ?? {}) as Captured['init'] });
        throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
      },
    });

    await expect(client.fetch('subscription', 'http://127.0.0.1:9000/sub'))
      .rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.dispatcher).toBeInstanceOf(Agent);
  });

  it('订阅超时 30 秒，fetcher 与 http-client 常量一致', () => {
    expect(SUBSCRIPTION_FETCH_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_TIMEOUT_MS.subscription).toBe(SUBSCRIPTION_FETCH_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS.github).toBe(15_000);
    expect(DEFAULT_TIMEOUT_MS.geo).toBe(10_000);
  });
});

describe('http-client 超时注入', () => {
  it('注入的 signal 会在超时后中止', async () => {
    let signal: AbortSignal | undefined;
    const client = createHttpClient(settings({ proxy_mode: 'off' }), {
      env: {},
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
