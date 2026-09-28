/**
 * 集成测试 - 分流规则 API
 * 验证 /api/rules/groups 与 /api/rules/catalog 端点返回真实数据
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createApp } from '@/api/routes';
import { createAuthService, createPasswordHash } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';

const TEST_CONTENT = ['ss://aes-256-gcm:pass1@jp1.example.com:8388#JP-1'].join('\n');

interface RuleItem {
  id: string;
  label: string;
  tag: string;
  target: string;
}
interface RuleGroupRes {
  key: string;
  name: string;
  icon: string;
  items: RuleItem[];
}
interface ResData {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function loginToken(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-pass' }),
  });
  const json = (await res.json()) as ResData;
  return (json.data as { token: string }).token;
}

describe('Rules API', () => {
  let app: ReturnType<typeof createApp>;
  let baseHeaders: Record<string, string>;

  beforeEach(async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    // 初始化 admin 密码哈希
    const { hash, salt } = await createPasswordHash('test-pass');
    await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    const auth = createAuthService(repos.sessions, async () => {
      const raw = await kv.get('admin:hash');
      return raw ? (JSON.parse(raw) as { hash: string; salt: string }) : null;
    });
    app = createApp({
      repos,
      auth,
      subscriptions: createSubscriptionService(repos, async () => TEST_CONTENT, async () => [], kv),
      config: createConfigService(repos, kv),
      adminPassword: 'test-pass',
      fetchRaw: async () => TEST_CONTENT,
      parseContent: async () => [],
    });
    const token = await loginToken(app);
    baseHeaders = { Cookie: `sub_session=${token}` };
  });

  it('GET /api/rules/groups 返回预定义规则大类', async () => {
    const res = await app.request('/api/rules/groups', { headers: baseHeaders });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    const groups = json.data as unknown as { groups: RuleGroupRes[] };
    const groupList = groups.groups;
    expect(Array.isArray(groupList)).toBe(true);
    expect(groupList.length).toBeGreaterThanOrEqual(9);
    for (const g of groupList) {
      expect(g.key).toBeTruthy();
      expect(g.icon).toBeTruthy();
      // user 组初始为空（v2.9.5 起无预置规则，等待用户添加），其余组必须有内容
      if (g.key === 'user') {
        expect(Array.isArray(g.items)).toBe(true);
      } else {
        expect(g.items.length).toBeGreaterThan(0);
      }
    }
    const names = groupList.map((g) => g.key);
    for (const k of ['ads', 'china-direct', 'ai', 'youtube', 'google', 'github', 'microsoft', 'apple', 'social', 'media', 'crypto', 'game', 'user']) {
      expect(names).toContain(k);
    }
    // 已删除的组不得再出现
    for (const k of ['netease', 'cloud', 'dev']) {
      expect(names).not.toContain(k);
    }
  });

  it('GET /api/rules/groups 未登录返回 401', async () => {
    const res = await app.request('/api/rules/groups');
    expect(res.status).toBe(401);
  });

  it('GET /api/rules/catalog 返回完整分类目录', async () => {
    const res = await app.request('/api/rules/catalog', { headers: baseHeaders });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    const data = json.data as unknown as { meta: { total: number }; catalog: RuleItem[] };
    expect(data.meta.total).toBeGreaterThan(1000);
    expect(data.catalog.length).toBeGreaterThan(1000);
  });

  it('GET /api/rules/catalog?q= 支持搜索', async () => {
    const res = await app.request('/api/rules/catalog?q=netflix', { headers: baseHeaders });
    const json = (await res.json()) as ResData;
    expect(json.success).toBe(true);
    const data = json.data as unknown as { catalog: RuleItem[] };
    expect(data.catalog.length).toBeGreaterThan(0);
    expect(data.catalog[0].id.toUpperCase()).toContain('NETFLIX');
  });

  it('PUT/GET /api/rules/selection 保存并读回勾选的规则', async () => {
    // 保存选择
    const put = await app.request('/api/rules/selection', {
      method: 'PUT',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['NETFLIX', 'OPENAI', 'CATEGORY-ADS-ALL'] }),
    });
    expect(put.status).toBe(200);
    // 读回
    const get = await app.request('/api/rules/selection', { headers: baseHeaders });
    const json = (await get.json()) as ResData;
    expect(json.success).toBe(true);
    const ids = (json.data as unknown as { ids: string[] }).ids;
    expect(ids).toEqual(['NETFLIX', 'OPENAI', 'CATEGORY-ADS-ALL']);
  });

  it('PUT /api/rules/selection 无效参数返回 400', async () => {
    const res = await app.request('/api/rules/selection', {
      method: 'PUT',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: 'not-array' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST/GET/DELETE /api/rules/custom 自定义规则增删', async () => {
    // 添加
    const post = await app.request('/api/rules/custom', {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'MY-SITE', label: '我的站点', groupKey: 'cloud', target: 'PROXY' }),
    });
    expect(post.status).toBe(200);
    // 读取
    const get = await app.request('/api/rules/custom', { headers: baseHeaders });
    const getJson = (await get.json()) as ResData;
    expect(getJson.success).toBe(true);
    const rules = (getJson.data as unknown as { rules: { id: string }[] }).rules;
    expect(rules.some(r => r.id === 'MY-SITE')).toBe(true);
    // 删除
    const del = await app.request('/api/rules/custom/MY-SITE', { method: 'DELETE', headers: baseHeaders });
    expect(del.status).toBe(200);
    const get2 = await app.request('/api/rules/custom', { headers: baseHeaders });
    const get2Json = (await get2.json()) as ResData;
    const rules2 = (get2Json.data as unknown as { rules: { id: string }[] }).rules;
    expect(rules2.some(r => r.id === 'MY-SITE')).toBe(false);
  });

  it('POST /api/rules/custom 空id返回400', async () => {
    const res = await app.request('/api/rules/custom', {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '', label: '空', groupKey: 'other', target: 'PROXY' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/rules/custom 含非法字符id返回400', async () => {
    const res = await app.request('/api/rules/custom', {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'BAD<ID>,x"', label: '非法', groupKey: 'other', target: 'PROXY' }),
    });
    expect(res.status).toBe(400);
  });
});