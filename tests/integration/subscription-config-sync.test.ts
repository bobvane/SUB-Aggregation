/**
 * v2.38.6 回归：订阅更新必须让 mihomo 快照失效（手动/自动共用 subscription.service.update）。
 *
 * 这是审计确认的线上问题：节点数据已更新，但 /api/output/mihomo 与 /sub/mihomo/<key>
 * 仍返回旧快照，直到某个手动动作（锁定/禁用/改规则）才刷新。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

const THREE = ['a', 'b', 'c'].map((x) => `ss://aes-256-gcm:p@node-${x}.example.com:8388#NODE-${x}`).join('\n');
const EIGHT = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `ss://aes-256-gcm:p@node-${x}.example.com:8388#NODE-${x}`).join('\n');

function countProxies(yaml: string): number {
  const i = yaml.indexOf('proxies:');
  if (i < 0) return -1;
  const rest = yaml.slice(i);
  const end = rest.search(/\n[a-z-]+:/);
  return ((end > 0 ? rest.slice(0, end) : rest).match(/- name:/g) || []).length;
}

describe('订阅更新 → 配置快照失效（v2.38.6）', () => {
  let kv: MemoryKvAdapter;
  let repos: ReturnType<typeof createRepositories>;
  let subs: ReturnType<typeof createSubscriptionService>;
  let config: ReturnType<typeof createConfigService>;

  beforeEach(async () => {
    kv = new MemoryKvAdapter();
    repos = createRepositories(kv);
    subs = createSubscriptionService(repos, async () => '', async () => [], kv);
    config = createConfigService(repos, kv);
    // 预填地理缓存：让配置生成不触发任何外部请求
    const ts = Date.now();
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await repos.settings.set(`ip_geo:node-${x}.example.com`, `${ts}|日本`);
    }
  });

  it('3 → 8 个节点后，mihomo 配置立即包含新增节点（无需任何手动动作）', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const sub = await subs.create('T', 'https://example.com/sub');
      await subs.update(sub.id, async () => THREE);
      const before = await config.generate('mihomo');
      expect(countProxies(before)).toBe(3);

      await subs.update(sub.id, async () => EIGHT);
      const after = await config.generate('mihomo');
      expect(countProxies(after)).toBe(8);
      expect(after).not.toBe(before);
      // 失效缓存不得触发任何外部请求（订阅抓取/测速/国家码都走各自入口）
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('节点数不变但信息变化时同样失效', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    try {
      const sub = await subs.create('T', 'https://example.com/sub');
      await subs.update(sub.id, async () => THREE);
      const before = await config.generate('mihomo');
      // 同数量、但服务器地址改名（指纹变化 → changed/added）
      const renamed = THREE.replace('node-a.example.com', 'node-a2.example.com');
      await subs.update(sub.id, async () => renamed);
      const after = await config.generate('mihomo');
      expect(after).not.toBe(before);
      expect(after).toContain('node-a2.example.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('更新失败时不失效、也不误报成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    try {
      const sub = await subs.create('T', 'https://example.com/sub');
      await subs.update(sub.id, async () => THREE);
      const before = await config.generate('mihomo');
      await expect(subs.update(sub.id, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      const after = await config.generate('mihomo');
      expect(after).toBe(before); // 数据未变 → 快照仍然命中
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('停用订阅会失效，且其节点不再进配置', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    try {
      const a = await subs.create('A', 'https://a/sub');
      const b = await subs.create('B', 'https://b/sub');
      await subs.update(a.id, async () => 'ss://aes-256-gcm:p@node-a.example.com:8388#A');
      await subs.update(b.id, async () => 'ss://aes-256-gcm:p@node-b.example.com:8388#B');
      expect(countProxies(await config.generate('mihomo'))).toBe(2);
      await subs.setEnabled(b.id, false);
      expect(countProxies(await config.generate('mihomo'))).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HTTP 端点：订阅更新后 /api/output/mihomo 与 /sub/mihomo/<key> 都用最新节点（v2.38.6）', () => {
  it('3 → 8 个节点后，预览与订阅链接都包含新增节点', async () => {
    const { createApp } = await import('@/api/routes');
    const { createAuthService, createPasswordHash } = await import('@/services/auth.service');

    const kv2 = new MemoryKvAdapter();
    const repos2 = createRepositories(kv2);
    const subs2 = createSubscriptionService(repos2, async () => '', async () => [], kv2);
    const config2 = createConfigService(repos2, kv2);
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv2.put('admin:hash', JSON.stringify({ hash, salt }));
    await kv2.put('setting:sub_key', 'sub-key-123');
    const auth = createAuthService(repos2.sessions, async () => {
      const raw = await kv2.get('admin:hash');
      return raw ? (JSON.parse(raw) as { hash: string; salt: string }) : null;
    });
    const app = createApp({
      repos: repos2,
      auth,
      subscriptions: subs2,
      config: config2,
      adminPassword: 'test-pass',
      fetchRaw: async () => '',
      parseContent: async () => [],
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    try {
      const login = await app.request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-pass' }),
      });
      const token = ((await login.json()) as { data: { token: string } }).data.token;
      const headers = { Cookie: 'sub_session=' + token };

      const sub = await subs2.create('T', 'https://example.com/sub');
      await subs2.update(sub.id, async () => THREE);
      const preview3 = await (await app.request('/api/output/mihomo', { headers })).text();
      expect(countProxies(preview3)).toBe(3);

      await subs2.update(sub.id, async () => EIGHT);
      const preview8 = await (await app.request('/api/output/mihomo', { headers })).text();
      expect(countProxies(preview8)).toBe(8);

      // 客户端订阅链接走同一个 generate()，必须同样是最新
      const subRes = await app.request('/sub/mihomo/sub-key-123');
      expect(subRes.status).toBe(200);
      const subText = await subRes.text();
      expect(countProxies(subText)).toBe(8);
      expect(subText).toContain('node-h.example.com');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
