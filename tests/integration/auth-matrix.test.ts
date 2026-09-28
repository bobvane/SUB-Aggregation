/**
 * 集成测试 - 鉴权矩阵（Authorization Matrix）
 * 验证受保护端点未登录时必须返回 401（防止授权回归）
 * 对应 Codex 安全审查建议：补充未登录访问受保护接口的 401 授权矩阵测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

function createTestApp() {
  const kv = new MemoryKvAdapter();
  const repos = createRepositories(kv);
  return async () => {
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    await kv.put('admin:username', 'admin');
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    return createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
  };
}

describe('Authorization Matrix（受保护端点未登录应 401）', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = await createTestApp()();
  });

  const protectedRequests: Array<{ method: string; path: string; desc: string }> = [
    { method: 'GET', path: '/api/subscriptions', desc: '订阅列表' },
    { method: 'POST', path: '/api/subscriptions', desc: '创建订阅' },
    { method: 'GET', path: '/api/nodes', desc: '节点列表' },
    { method: 'GET', path: '/api/rules/groups', desc: '规则分组' },
    { method: 'GET', path: '/api/dashboard', desc: '仪表盘' },
    { method: 'GET', path: '/api/settings', desc: '设置读取' },
    { method: 'PUT', path: '/api/settings', desc: '设置写入' },
    { method: 'GET', path: '/api/sub-key', desc: '订阅访问密钥' },
    { method: 'POST', path: '/api/auth/password', desc: '修改密码' },
    { method: 'POST', path: '/api/auth/username', desc: '修改用户名' },
  ];

  for (const req of protectedRequests) {
    it(`${req.method} ${req.path} → 无令牌应 401（${req.desc}）`, async () => {
      const res = await app.request(req.path, { method: req.method });
      expect(res.status).toBe(401);
    });
  }

  // 公开端点不应要求鉴权
  const publicRequests: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/health' },
    { method: 'GET', path: '/api/meta' },
    { method: 'POST', path: '/api/auth/login' },
  ];

  for (const req of publicRequests) {
    it(`${req.method} ${req.path} → 无令牌不应 401（公开端点）`, async () => {
      const res = await app.request(req.path, { method: req.method });
      expect(res.status).not.toBe(401);
    });
  }

  it('登录后访问受保护端点应 200（正常授权路径）', async () => {
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { success: boolean; data?: { token?: string } };
    const token = body.data?.token;
    expect(token).toBeTruthy();

    const res = await app.request('/api/subscriptions', {
      headers: { Cookie: `sub_session=${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('访问 /sub/:format/错误token 应 401（订阅令牌校验）', async () => {
    const res = await app.request('/sub/mihomo/wrong-token');
    expect(res.status).toBe(401);
  });

  it('访问 /sub/:format/正确sub_key 应可输出（订阅令牌受控开放）', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    await repos.settings.set('sub_key', 'secret-sub-key-123');
    const appWithKey = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => '', async () => [], async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    const res = await appWithKey.request('/sub/mihomo/secret-sub-key-123');
    // 有合法 sub_key 应能输出配置（非 401）
    expect(res.status).not.toBe(401);
  });
});