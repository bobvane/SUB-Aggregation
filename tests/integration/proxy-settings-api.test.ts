/**
 * 代理设置 API（v2.46.0）
 * - 地址 / 5 项目标策略 / bypass 的读写与校验
 * - 只提交改动字段不会固化推断配置
 * - 订阅不再有独立的代理策略
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

interface SettingsData {
  app_name: string;
  proxy_url: string;
  proxy_targets: Record<string, string>;
  proxy_bypass: string;
  proxy_meta: {
    targets: Array<{ key: string; label: string; hint: string }>;
    bypassPresets: string[];
    bypassDefaults: string;
    probeTimeoutMs: number;
  };
}

describe('代理设置 API', () => {
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;

  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as Parameters<typeof app.request>[3];

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(init.headers as Record<string, string> | undefined),
      },
    }, {}, executionCtx);

  const getSettings = async (): Promise<SettingsData> => {
    const res = await request('/api/settings');
    return ((await res.json()) as { data: SettingsData }).data;
  };

  beforeEach(async () => {
    vi.unstubAllEnvs();
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    await kv.put('admin:username', 'admin');
    const auth = createAuthService(repos.sessions, async () => ({ hash, salt }));
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => [], kv),
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

  it('全新部署：地址为空、5 项全自动，并下发渲染用的元数据', async () => {
    const d = await getSettings();
    expect(d.proxy_url).toBe('');
    expect(d.proxy_targets).toEqual({
      subscription: 'auto', rules: 'auto', version: 'auto', dns: 'auto', geo: 'auto',
    });
    expect(d.proxy_bypass).toBe('');
    expect(d.proxy_meta.targets.map((t) => t.key)).toEqual([
      'subscription', 'rules', 'version', 'dns', 'geo',
    ]);
    expect(d.proxy_meta.targets[0].label).toBe('订阅拉取');
    expect(d.proxy_meta.bypassPresets).toContain('192.168.2.0/24');
    expect(d.proxy_meta.bypassDefaults).toContain('localhost');
    expect(d.proxy_meta.probeTimeoutMs).toBe(3_000);
  });

  it('保存地址后返回脱敏值，密码占位符可原样回存', async () => {
    const put = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        proxy_url: 'http://user:secret@127.0.0.1:7890',
        proxy_targets: { subscription: 'on', geo: 'off' },
        proxy_bypass: 'example.com, 10.0.0.0/8',
      }),
    });
    expect(put.status).toBe(200);

    const d = await getSettings();
    expect(d.proxy_url).toContain('***');
    expect(d.proxy_url).not.toContain('secret');
    expect(d.proxy_targets.subscription).toBe('on');
    expect(d.proxy_targets.geo).toBe('off');
    expect(d.proxy_targets.rules).toBe('auto'); // 未提交的项保持默认
    expect(d.proxy_bypass).toBe('example.com,10.0.0.0/8');

    // 用脱敏值再次保存：密码应沿用原值
    const putAgain = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: d.proxy_url }),
    });
    expect(putAgain.status).toBe(200);
    expect(await repos.settings.get('proxy_url')).toBe('http://user:secret@127.0.0.1:7890');
  });

  it('只提交改动字段：改应用名不会碰任何代理配置', async () => {
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        proxy_url: 'http://127.0.0.1:7893',
        proxy_targets: { dns: 'on' },
        proxy_bypass: 'corp.example.com',
      }),
    });

    const put = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ app_name: '我的聚合' }),
    });
    expect(put.status).toBe(200);

    const d = await getSettings();
    expect(d.app_name).toBe('我的聚合');
    expect(d.proxy_url).toContain('127.0.0.1:7893');
    expect(d.proxy_targets.dns).toBe('on');
    expect(d.proxy_bypass).toBe('corp.example.com');
  });

  it('targets 支持部分更新：只改一项不影响其余', async () => {
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_targets: { subscription: 'off', rules: 'on' } }),
    });
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_targets: { version: 'off' } }),
    });

    const d = await getSettings();
    expect(d.proxy_targets).toEqual({
      subscription: 'off', rules: 'on', version: 'off', dns: 'auto', geo: 'auto',
    });
  });

  it('清空地址即恢复全部直连（地址是唯一开关）', async () => {
    await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: 'http://127.0.0.1:7893' }),
    });
    expect(await repos.settings.get('proxy_url')).toBe('http://127.0.0.1:7893');

    const put = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: '' }),
    });
    expect(put.status).toBe(200);
    expect(await repos.settings.get('proxy_url')).toBe('');
    expect((await getSettings()).proxy_url).toBe('');
  });

  it('拒绝非法地址、未知目标、非法策略值与非对象', async () => {
    const badUrl = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: 'socks5://127.0.0.1:1080' }),
    });
    expect(badUrl.status).toBe(400);

    const unknownTarget = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_targets: { github: 'on' } }),
    });
    expect(unknownTarget.status).toBe(400);

    const badMode = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_targets: { subscription: 'always' } }),
    });
    expect(badMode.status).toBe(400);

    const notObject = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_targets: 'subscription=on' }),
    });
    expect(notObject.status).toBe(400);

    // 校验失败的写入不应落盘
    expect(await repos.settings.get('proxy_targets')).toBeNull();
  });

  it('旧的 proxy_mode / proxy_scope 字段被忽略，不再写入', async () => {
    const put = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_mode: 'manual', proxy_scope: ['github'] }),
    });
    expect(put.status).toBe(200);
    expect(await repos.settings.get('proxy_mode')).toBeNull();
    expect(await repos.settings.get('proxy_scope')).toBeNull();
  });

  it('订阅不再有独立代理策略：带旧字段也能创建，但响应不再返回 useProxy', async () => {
    const created = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 's', url: 'https://example.com/sub', useProxy: 'on' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string; useProxy?: string } };
    expect(createdBody.data.useProxy).toBeUndefined();

    const listed = await request('/api/subscriptions');
    const listBody = (await listed.json()) as { data: Array<{ id: string; useProxy?: string }> };
    const found = listBody.data.find((item) => item.id === createdBody.data.id);
    expect(found?.useProxy).toBeUndefined();
  });
});
