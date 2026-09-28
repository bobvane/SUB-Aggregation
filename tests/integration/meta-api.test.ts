/**
 * 集成测试 - 项目元信息 API（公开）
 * 验证 /api/meta 与 /api/meta/check-upgrade 端点
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

interface ResData {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

describe('Meta API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => {
      const raw = await kv.get('admin:hash');
      return raw ? (JSON.parse(raw) as { hash: string; salt: string }) : null;
    });
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
  });

  it('GET /api/meta 返回项目信息（公开，无需认证）', async () => {
    const res = await app.request('/api/meta');
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    const meta = json.data!.meta as { name: string; version: string; repo: string; author: string };
    expect(typeof meta.name).toBe('string');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(meta.repo).toContain('github.com');
    expect(typeof meta.author).toBe('string');
  });

  it('GET /api/meta/check-upgrade 能从 releases Atom 订阅解析出最新版本', async () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1/v9.9.9</id>
    <updated>2026-01-01T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/bobvane/SUB-Aggregation/releases/tag/v9.9.9"/>
    <title>v9.9.9</title>
  </entry>
  <entry><id>older</id><title>v1.0.0</title></entry>
</feed>`;
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calledUrl = String(url);
        return new Response(feed, { status: 200 });
      })
    );
    try {
      const res = await app.request('/api/meta/check-upgrade');
      expect(res.status).toBe(200);
      const up = ((await res.json()) as ResData).data as {
        latest: string;
        hasUpdate: boolean;
        checked: boolean;
        releaseUrl: string;
      };
      expect(up.latest).toBe('9.9.9');
      expect(up.hasUpdate).toBe(true);
      expect(up.checked).toBe(true);
      expect(up.releaseUrl).toContain('/releases/tag/v9.9.9');
      // 只打 Atom 订阅（REST API 有 60/h 匿名配额，共享出口必被限流）
      expect(calledUrl).toContain('releases.atom');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET /api/meta/check-upgrade：GitHub 不可达时如实标记 checked=false（不再谎报无更新）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    try {
      const up = ((await (await app.request('/api/meta/check-upgrade')).json()) as ResData).data as {
        checked: boolean;
        hasUpdate: boolean;
        checkError?: string;
      };
      expect(up.checked).toBe(false);
      expect(up.hasUpdate).toBe(false);
      expect(up.checkError).toBe('network');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET /api/meta/check-upgrade：GitHub 返回 403（限流）时不冒充「已检查」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 403 })));
    try {
      const up = ((await (await app.request('/api/meta/check-upgrade')).json()) as ResData).data as {
        checked: boolean;
        checkError?: string;
      };
      expect(up.checked).toBe(false);
      expect(up.checkError).toBe('http 403');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});