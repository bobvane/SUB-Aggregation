/**
 * 代理设置 API（v2.44.0）
 * - 设置项校验与脱敏
 * - 单条订阅 useProxy 校验与持久化
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

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

  beforeEach(async () => {
    kv = new MemoryKvAdapter();
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

  it('保存手动代理后返回脱敏地址，密码占位符可原样回存', async () => {
    const put = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        proxy_mode: 'manual',
        proxy_url: 'http://user:secret@127.0.0.1:7890',
        proxy_scope: ['subscription', 'github'],
        proxy_bypass: 'example.com, 10.0.0.0/8',
        proxy_fallback: false,
      }),
    });
    expect(put.status).toBe(200);

    const get = await request('/api/settings');
    const body = (await get.json()) as { data: Record<string, unknown> };
    expect(body.data.proxy_mode).toBe('manual');
    expect(String(body.data.proxy_url)).toContain('***');
    expect(String(body.data.proxy_url)).not.toContain('secret');
    expect(body.data.proxy_scope).toEqual(['subscription', 'github']);
    expect(body.data.proxy_fallback).toBe(false);

    // 用脱敏值再次保存：密码应沿用原值
    const masked = String(body.data.proxy_url);
    const putAgain = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: masked }),
    });
    expect(putAgain.status).toBe(200);
    expect(await repos.settings.get('proxy_url')).toBe('http://user:secret@127.0.0.1:7890');
  });

  it('拒绝非法代理模式、地址与用途', async () => {
    const badMode = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_mode: 'socks5' }),
    });
    expect(badMode.status).toBe(400);

    const badUrl = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_url: 'socks5://127.0.0.1:1080' }),
    });
    expect(badUrl.status).toBe(400);

    const badScope = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_scope: ['subscription', 'unknown'] }),
    });
    expect(badScope.status).toBe(400);

    const badFallback = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ proxy_fallback: 'yes' }),
    });
    expect(badFallback.status).toBe(400);
  });

  it('订阅创建/编辑会校验并保存 useProxy', async () => {
    const bad = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 's', url: 'https://example.com/sub', useProxy: 'always' }),
    });
    expect(bad.status).toBe(400);

    const created = await request('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ name: 's', url: 'https://example.com/sub', useProxy: 'on' }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string; useProxy: string } };
    expect(createdBody.data.useProxy).toBe('on');

    const patched = await request(`/api/subscriptions/${createdBody.data.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ useProxy: 'off' }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { data: { useProxy: string } };
    expect(patchedBody.data.useProxy).toBe('off');

    const listed = await request('/api/subscriptions');
    const listBody = (await listed.json()) as { data: Array<{ id: string; useProxy: string }> };
    expect(listBody.data.find((item) => item.id === createdBody.data.id)?.useProxy).toBe('off');
  });
});
