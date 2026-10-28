/**
 * 集成测试 - HTTP 响应层
 * ① 响应压缩：大响应带 Accept-Encoding 时必须 gzip（首页/nodes/输出配置都是 100KB 量级）
 * ② 订阅列表返回 url 字段（前端「链接」列依赖它，缺失会恒显示 '-'）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

describe('HTTP 响应层（压缩 / 订阅 url 字段）', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let repos: ReturnType<typeof createRepositories>;

  beforeEach(async () => {
    const kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    await kv.put('admin:username', 'admin');
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
    });
    const { data } = (await login.json()) as { data: { token: string } };
    cookie = `sub_session=${data.token}`;
  });

  it('大响应带 Accept-Encoding: gzip → 压缩，未带则不压缩', async () => {
    const plain = await app.request('/api/rules/catalog?limit=5000', { headers: { Cookie: cookie } });
    expect(plain.status).toBe(200);
    const plainLen = (await plain.arrayBuffer()).byteLength;
    expect(plainLen).toBeGreaterThan(1024); // 小于阈值不压缩，测试前提
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(plain.headers.get('content-type')).toContain('application/json');

    const gz = await app.request('/api/rules/catalog?limit=5000', {
      headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' },
    });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    // 解压回来内容必须完整
    const raw = gunzipSync(Buffer.from(await gz.arrayBuffer())).toString('utf-8');
    expect(JSON.parse(raw).success).toBe(true);
    expect(raw.length).toBe(plainLen);
  });

  it('小响应压缩与否都不影响可读性（阈值对 c.json 不生效，但解压后内容一致）', async () => {
    const res = await app.request('/api/health', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(res.status).toBe(200);
    const raw = res.headers.get('content-encoding') === 'gzip'
      ? gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf-8')
      : await res.text();
    expect(JSON.parse(raw).status).toBe('ok');
  });

  it('订阅列表必须返回 url（前端「链接」列的数据源）', async () => {
    await app.request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Test Airport', url: 'https://example.com/sub?token=abc' }),
    });

    const res = await app.request('/api/subscriptions', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ name: string; url?: string }> };
    const sub = data.find((s) => s.name === 'Test Airport');
    expect(sub?.url).toBe('https://example.com/sub?token=abc');
  });

  it('订阅列表必须返回失败原因和自动重试状态（前端错误详情的数据源）', async () => {
    const created = await repos.subscriptions.create({
      name: 'Failing Airport',
      url: 'https://example.com/fail',
    });
    const now = Date.now();
    await repos.subscriptions.update(created.id, {
      status: 'error',
      errorMessage: 'getaddrinfo ENOTFOUND example.com',
      retryCount: 2,
      nextRetryAt: now + 3_600_000,
      lastErrorAt: now,
    });

    const res = await app.request('/api/subscriptions', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{
        id: string;
        status: string;
        errorMessage: string | null;
        retryCount: number;
        nextRetryAt: number | null;
        lastErrorAt: number | null;
      }>;
    };
    const sub = data.find((s) => s.id === created.id);
    expect(sub?.status).toBe('error');
    expect(sub?.errorMessage).toBe('getaddrinfo ENOTFOUND example.com');
    expect(sub?.retryCount).toBe(2);
    expect(sub?.nextRetryAt).toBe(now + 3_600_000);
    expect(sub?.lastErrorAt).toBe(now);
  });

  it('PATCH /api/subscriptions/:id 可编辑名称和链接，并在链接变化时清除旧失败状态', async () => {
    const created = await repos.subscriptions.create({
      name: 'Old Name',
      url: 'https://example.com/old',
    });
    await repos.subscriptions.update(created.id, {
      status: 'error',
      errorMessage: 'old failure',
      retryCount: 4,
      lastErrorAt: Date.now(),
    });

    const res = await app.request(`/api/subscriptions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'New Name', url: 'https://example.com/new' }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { name: string; url: string; status: string; errorMessage: string | null; retryCount: number };
    };
    expect(data.name).toBe('New Name');
    expect(data.url).toBe('https://example.com/new');
    expect(data.status).toBe('active');
    expect(data.errorMessage).toBeNull();
    expect(data.retryCount).toBe(0);

    const stored = await repos.subscriptions.getById(created.id);
    expect(stored?.name).toBe('New Name');
    expect(stored?.url).toBe('https://example.com/new');
    expect(stored?.status).toBe('active');
    expect(stored?.errorMessage).toBeUndefined();
  });

  it('PATCH /api/subscriptions/:id 拒绝空名称/空链接', async () => {
    const created = await repos.subscriptions.create({
      name: 'Valid',
      url: 'https://example.com/sub',
    });

    const res = await app.request(`/api/subscriptions/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});
