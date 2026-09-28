/**
 * API 路由
 * TASK 2.4 - API Router
 * 07_API_SPECIFICATION.md：所有端点 /api 前缀，统一响应格式
 */

import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { Repositories, KVStorage } from '@/storage/kv';
import { AuthService } from '@/services/auth.service';
import {
  createSessionCookie,
  createClearCookie,
} from '@/services/auth.service';
import { SubscriptionService } from '@/services/subscription.service';
import { ConfigService } from '@/services/config.service';
import { requireAuth, errorHandler, readBody, AppError, ERRORS, getToken } from './middleware';
import { rateLimit, createKvRateLimit } from './rate-limit';
import { nodeToLink } from '@/services/config.service';
import { nodeFingerprint } from '@/models/node';
import { deduplicateNodes } from '@/parser';
import { prewarmIpGeo } from '@/services/ip-geo.service';
import { APP_META, isNewerVersion } from '@/meta';
import { createCatalogSyncService, CatalogSyncService } from '@/services/catalog-sync.service';
import { RuleCatalogMeta } from '@/models/rule-catalog';
import { createSnapshotCache } from '@/services/config-cache.service';

/**
 * 请求是否走 https。
 * 直连时看 URL 协议；nginx / tailscale serve 等反代后面 URL 永远是 http，
 * 由反代给的 x-forwarded-proto 决定。决定 session cookie 要不要带 Secure 属性
 * （明文 http 下带 Secure 会被浏览器整条丢弃 → 登录后立刻掉线）。
 */
function isHttpsRequest(c: { req: { url: string; header: (name: string) => string | undefined } }): boolean {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  return proto === 'https';
}

/**
 * 恒定时间字符串比较（防时序侧信道）。
 * 不用 crypto.subtle.timingSafeEqual（各运行时支持不一），
 * 自实现：先比对长度避免泄漏，再逐字节异或累加，时间与内容无关。
 * 用于比较长期有效的订阅访问密钥。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface AppDeps {
  repos: Repositories;
  auth: AuthService;
  subscriptions: SubscriptionService;
  config: ConfigService;
  adminPassword: string;
  /** 订阅内容抓取函数（含 SSRF 防护） */
  fetchRaw: (url: string) => Promise<string>;
  /** 节点解析管线（parser 完成后注入） */
  parseContent: (content: string, source: string) => Promise<unknown[]>;
  /** 规则目录同步服务（可选注入，默认内部构造） */
  catalogSync?: CatalogSyncService;
  /** KV 存储（可选）：提供时可启用跨实例 KV 限流（生产建议注入） */
  storage?: KVStorage;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { repos, auth, subscriptions, config } = deps;
  // 裸 KV 存储：探测引擎/健康数据/操作日志/快照缓存都直接读写它。
  // 曾用 `repos.settings as unknown as KVStorage` 强转 —— 但 KvSettingsRepository 只有 get/set，
  // 没有 list/put：导致 GET /api/nodes/health 抛 500，且探测引擎在订阅更新后静默失败（异常被 waitUntil 吞掉），一条健康数据都写不进去。
  const storage: KVStorage = deps.storage ?? repos.kv;
  // v2.32: 配置快照缓存(用于订阅生效)
  const snapshotCache = createSnapshotCache(storage);
  // 规则目录同步服务：默认用全局 fetch 拉 GitHub；测试可注入 mock
  const catalogSync: CatalogSyncService =
    deps.catalogSync ??
    createCatalogSyncService(repos, (url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`);
      return r.text();
    }));

  // ============ 全局错误处理 ============
  app.onError(errorHandler);

  // ============ 响应压缩 ============
  // 大响应（首页 HTML 107KB、/api/nodes 86KB、输出配置 120KB）不压缩会浪费带宽，
  // 走 Tailscale 远程访问时尤其明显。用 hono 自带中间件，零新依赖。
  // 注意：c.json() 不带 Content-Length，hono 的 1KB 阈值对它不生效，小响应也会被压
  // （几十字节的开销，忽略不计）。
  app.use('*', compress());

  // ============ Health ============
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  // ============ Meta（项目信息，公开） ============
  // app_name：用户自定义站点名（设置页保存），登录前也需显示，故放公开接口
  app.get('/api/meta', async (c) => {
    const appName = await repos.settings.get('app_name');
    return c.json({
      success: true,
      data: { meta: APP_META, app_name: appName ?? APP_META.name },
    });
  });

  // 升级检测：读 GitHub releases 的 Atom 订阅
  // 为什么不用 REST API（/releases/latest）：匿名额度只有 60 次/小时/出口 IP，
  // 共享出口（代理/旁路由）下经常是 403，而 403 会被静默当成「无更新」→ 前端永远不提示。
  // Atom 免鉴权、无配额，实测可用。
  let upgradeCheck: { at: number; ttl: number; body: unknown } | null = null;
  app.get('/api/meta/check-upgrade', async (c) => {
    const FEED = 'https://github.com/bobvane/SUB-Aggregation/releases.atom';
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 成功缓存 6h
    const FAIL_TTL_MS = 10 * 60 * 1000; // 失败只缓存 10min，别把一次网络抖动锁 6 小时
    const now = Date.now();
    if (upgradeCheck && now - upgradeCheck.at < upgradeCheck.ttl) {
      return c.json(upgradeCheck.body);
    }

    let payload: unknown;
    let ttl = FAIL_TTL_MS;
    try {
      const res = await fetch(FEED, { headers: { 'User-Agent': 'sub-aggregation' } });
      const entry = res.ok ? ((await res.text()).split('<entry>')[1] ?? '') : '';
      const tag = entry.match(/<title>([^<]+)<\/title>/)?.[1] ?? '';
      const url = entry.match(/href="([^"]*\/releases\/tag\/[^"]+)"/)?.[1];
      const latest = tag.trim().replace(/^v/, '');
      if (latest) {
        payload = {
          success: true,
          data: {
            current: APP_META.version,
            latest,
            hasUpdate: isNewerVersion(latest, APP_META.version),
            releaseUrl: url || APP_META.repo,
            checked: true,
          },
        };
        ttl = CACHE_TTL_MS;
      } else {
        payload = {
          success: true,
          data: {
            current: APP_META.version,
            latest: APP_META.version,
            hasUpdate: false,
            checked: false,
            checkError: `http ${res.status}`,
          },
        };
      }
    } catch {
      payload = {
        success: true,
        data: {
          current: APP_META.version,
          latest: APP_META.version,
          hasUpdate: false,
          checked: false,
          checkError: 'network',
        },
      };
    }
    upgradeCheck = { at: Date.now(), ttl, body: payload };
    return c.json(payload);
  });

  // ============ Auth ============
  // 敏感操作（登录/改密/改用户名）限流：防暴力破解
  // 优先用 KV 限流（跨实例共享，生产生效）；未注入 storage 时退回单实例内存限流
  const buildRateLimit = (maxRequests: number) =>
    deps.storage
      ? createKvRateLimit(deps.storage, { windowSeconds: 60, maxRequests })
      : rateLimit({ windowSeconds: 60, maxRequests });
  const loginRateLimit = buildRateLimit(10);
  const sensitiveOpRateLimit = buildRateLimit(5);
  app.post('/api/auth/login', loginRateLimit, async (c) => {
    const body = await readBody<{ username?: string; password?: string }>(c);
    if (!body.password || typeof body.password !== 'string') {
      throw ERRORS.INVALID_PARAMETER('password is required');
    }
    // 兼容旧客户端：未传 username 时默认 'admin'
    const username = (body.username || 'admin').trim();

    const token = await auth.login(username, body.password);
    if (!token) {
      return c.json(
        { success: false, error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } },
        401
      );
    }

    c.header('Set-Cookie', createSessionCookie(token, isHttpsRequest(c)));
    return c.json({ success: true, data: { token } });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = getToken(c);
    if (token) {
      await auth.logout(token);
    }
    c.header('Set-Cookie', createClearCookie(isHttpsRequest(c)));
    return c.json({ success: true });
  });

  // 仪表盘数据计算：/api/dashboard 与首屏 bootstrap 共用，避免两处重复
  // v2.36.3：节点口径与「节点列表」页对齐 —— 去重 + 测活健康（存活/不通/已抛弃/上次测活）
  const buildDashboard = async () => {
    const subs = await subscriptions.list();
    // 两种口径各取一次（并行）：enabled=启用订阅的节点，all=含停用订阅的全部节点（用户 2026-09-24）
    const [nodes, allNodes] = await Promise.all([repos.nodes.getAll(), repos.nodes.getAll(true)]);
    const lastUpdate = subs.reduce((max, s) => Math.max(max, s.updatedAt), 0);
    const disabled = await config.getDisabledNodes();
    const enabledNodes = nodes.filter(n => !disabled.includes(nodeFingerprint(n)));
    // 与 /api/nodes 同口径：统一按 server:port:protocol 去重
    const unique = deduplicateNodes(allNodes);
    // 测活健康（与节点列表页同一数据源 health:latest）
    const { getAllNodeHealth } = await import('@/services/node-probe.service');
    const healthByFp = new Map((await getAllNodeHealth(storage)).map(h => [h.fingerprint, h]));
    const dropped = new Set(await config.getDroppedNodes());
    let alive = 0, dead = 0, lastProbe = 0;
    unique.forEach(n => {
      const h = healthByFp.get(nodeFingerprint(n));
      if (!h) return;
      if (h.status === 'alive') alive++; else dead++;
      if (h.timestamp > lastProbe) lastProbe = h.timestamp;
    });
    // 按协议统计：口径与「节点总数」一致（全部订阅）
    const protoCount: Record<string, number> = {};
    allNodes.forEach(n => { const p = n.protocol || 'unknown'; protoCount[p] = (protoCount[p] || 0) + 1; });
    return {
      subscriptions: subs.length,
      enabledSubscriptions: subs.filter(s => s.enabled).length,
      disabledSubscriptions: subs.filter(s => !s.enabled).length,
      nodes: allNodes.length,
      duplicates: allNodes.length - unique.length,
      uniqueNodes: unique.length,
      enabledNodes: enabledNodes.length,
      disabledNodes: disabled.length,
      alive, dead,
      droppedNodes: unique.filter(n => dropped.has(nodeFingerprint(n))).length,
      lastProbe: lastProbe || null,
      protoCount,
      lastUpdate: lastUpdate || null,
      status: 'ok',
    };
  };

  // 会话 / 首屏 bootstrap
  // 前端原路径是 3 次串行往返：/auth/session → /auth/username → /dashboard
  // 带 ?page=dashboard 时一次返回「登录态 + 用户名 + 首屏数据」，首次渲染只需 1 次往返。
  // 不传 page（或传其他页）时不计算仪表盘，避免为没在看的页面白做 KV 读取。
  app.get('/api/auth/session', async (c) => {
    const token = getToken(c);
    const authenticated = token ? await auth.validateSession(token) : false;
    if (!authenticated) {
      return c.json({ success: true, data: { authenticated: false } });
    }
    const page = c.req.query('page') || '';
    const [username, dashboard] = await Promise.all([
      auth.getUsername(),
      page === 'dashboard' ? buildDashboard() : Promise.resolve(undefined),
    ]);
    return c.json({ success: true, data: { authenticated: true, username, page: page || null, dashboard } });
  });

  // ============ 受保护路由（需认证） ============
  app.use('/api/subscriptions/*', requireAuth(auth));
  app.use('/api/nodes/*', requireAuth(auth));
  app.use('/api/rules/*', requireAuth(auth));
  app.use('/api/dashboard', requireAuth(auth));

  // ============ Subscription API ============

  // 获取订阅列表
  app.get('/api/subscriptions', async (c) => {
    const list = await subscriptions.list();
    return c.json({
      success: true,
      data: list.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        enabled: s.enabled,
        status: s.status,
        nodeCount: s.nodeCount ?? 0,
        updatedAt: s.updatedAt,
      })),
    });
  });

  // 创建订阅
  app.post('/api/subscriptions', requireAuth(auth), async (c) => {
    const body = await readBody<{ name?: string; url?: string }>(c);
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw ERRORS.INVALID_PARAMETER('name is required');
    }
    if (!body.url || typeof body.url !== 'string') {
      throw ERRORS.INVALID_PARAMETER('url is required');
    }

    const sub = await subscriptions.create(body.name.trim(), body.url.trim());
    // v2.35: 新增订阅完成后同样触发全量测活（§8 触发点 3/4），不阻塞响应
    c.executionCtx?.waitUntil(
      (async () => {
        try {
          const { probeAllNodes } = await import('@/services/node-probe.service');
          const nodes = deduplicateNodes(await repos.nodes.getAll());
          await probeAllNodes(nodes, storage);
        } catch (e) {
          console.warn(`[SubscriptionCreate:${sub.id}] 节点测活失败(后台,不阻塞): ${(e as Error).message}`);
        }
      })()
    );
    return c.json({ success: true, data: { id: sub.id } }, 201);
  });

  // 获取单个订阅
  app.get('/api/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const sub = await subscriptions.getById(id);
    if (!sub) throw ERRORS.SUBSCRIPTION_NOT_FOUND();
    return c.json({ success: true, data: { id: sub.id, name: sub.name, url: sub.url } });
  });

  // 删除订阅
  app.delete('/api/subscriptions/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = await subscriptions.delete(id);
    if (!deleted) throw ERRORS.SUBSCRIPTION_NOT_FOUND();
    return c.json({ success: true });
  });

  // 启用/停用订阅(不删除,留待以后再用)
  app.post('/api/subscriptions/:id/enabled', async (c) => {
    const id = c.req.param('id') as string;
    const body = await readBody<{ enabled?: boolean }>(c);
    if (typeof body.enabled !== 'boolean') {
      throw ERRORS.INVALID_PARAMETER('enabled is required');
    }
    const sub = await subscriptions.setEnabled(id, body.enabled);
    if (!sub) throw ERRORS.SUBSCRIPTION_NOT_FOUND();
    // v2.32: 禁用/启用节点时失效缓存
    await snapshotCache.invalidateAll();
    return c.json({ success: true, data: { id: sub.id, enabled: sub.enabled } });
  });

  // 更新订阅（重新抓取解析）
  // 更新订阅（重新抓取解析）。加 KV 限流防资源滥用（v2.23.0）
  // v2.32: 返回 Subscription Diff 结果（新增/删除/保持/变化）
  app.post('/api/subscriptions/:id/update', sensitiveOpRateLimit, async (c) => {
    const id = c.req.param('id') as string;
    try {
      const { nodeCount, diff } = await subscriptions.update(id, deps.fetchRaw);
      // v2.32: 更新完成后触发节点测活引擎（全量扫描）
      c.executionCtx?.waitUntil(
        (async () => {
          try {
            const { probeAllNodes } = await import('@/services/node-probe.service');
            const nodes = deduplicateNodes(await repos.nodes.getAll());
            await probeAllNodes(nodes, storage);
          } catch (e) {
            console.warn(`[SubscriptionUpdate:${id}] 节点测活失败(后台,不阻塞): ${(e as Error).message}`);
          }
        })()
      );
      // v2.32: IP 地理预填充改为后台执行（waitUntil），不再同步阻塞订阅更新响应
      // 之前同步 prewarmIpGeo 会让手动更新在节点多/未识别多时拖到 >15s，被前端 AbortController 掐断报「signal is aborted without reason」
      // v2.21.0：executionCtx 空值防御——Hono 未传第三参时（某些调用路径），
      // c.executionCtx 为 undefined，直接 waitUntil 会抛 'This context has no ExecutionContext'
      c.executionCtx?.waitUntil(
        (async () => {
          try {
            const nodes = deduplicateNodes(await repos.nodes.getAll());
            const servers = [...new Set(nodes.map((n) => n.server).filter((v): v is string => typeof v === 'string'))];
            if (servers.length > 0) {
              const geoService = await import('@/services/ip-geo.service');
              const ipGeoCache = { get: (k: string) => repos.settings.get(k), set: (k: string, v: string) => repos.settings.set(k, v) };
              const geoResult = await geoService.prewarmIpGeo(servers, ipGeoCache);
              // v2.25.0：预热后若有未识别 IP 则激活 GeoRetry 门闩，唤醒每分钟 cron 继续重查
              const unlocated = await geoService.filterUnlocatedServers(servers, ipGeoCache);
              await geoService.activateGeoRetry(unlocated.length, repos.settings);
              console.warn(`[SubscriptionUpdate:${id}] IP地理预填充完成(后台): 总数 ${geoResult.total}，已缓存 ${geoResult.cached}，新查 ${geoResult.queried}，解析成功 ${geoResult.resolved}，失败 ${geoResult.failed}，剩余未识别 ${unlocated.length}`);
            }
          } catch (e) {
            console.warn(`[SubscriptionUpdate:${id}] IP地理预填充失败(后台,不阻塞): ${(e as Error).message}`);
          }
        })()
      );
      return c.json({ success: true, data: { nodeCount, diff } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw ERRORS.FETCH_FAILED((err as Error).message);
    }
  });

  // ============ Node API ============

  // 获取节点列表（可选按订阅过滤）；统一按 server:port:protocol 去重
  app.get('/api/nodes', async (c) => {
    const subscriptionId = c.req.query('subscriptionId');
    const disabled = new Set(await config.getDisabledNodes());
    // 熔断抛弃（连续失败 3 次）—— 前端要能看到"哪些被抛弃了"
    const dropped = new Set(await config.getDroppedNodes());
    const { getAllNodeHealth, nodeLatencyMs } = await import('@/services/node-probe.service');
    const healthByFp = new Map((await getAllNodeHealth(storage)).map(h => [h.fingerprint, h]));
    const mapper = (n: import('@/models/node').Node) => {
      const fp = nodeFingerprint(n);
      const h = healthByFp.get(fp);
      return {
        name: n.name,
        protocol: n.protocol,
        server: n.server,
        port: n.port,
        tls: n.tls ?? false,
        country: n.metadata?.country ?? '',
        link: nodeToLink(n),
        fingerprint: fp,
        enabled: !disabled.has(fp),
        dropped: dropped.has(fp),
        healthStatus: h?.status ?? null,
        statusMachine: h?.statusMachine ?? null,
        score: h?.score ?? null,
        latency: h ? nodeLatencyMs(h) : null,
        error: h?.error ?? null,
      };
    };
    if (subscriptionId) {
      const nodes = await repos.nodes.getBySubscription(subscriptionId);
      return c.json({
        success: true,
        data: (await config.autoNamed(nodes)).map(mapper),
      });
    }
    const all = await repos.nodes.getAll();
    const original = all.length;
    const unique = deduplicateNodes(all);
    const geoUnlocated = await config.countUnlocatedGeo(unique.map(n => n.server));
    return c.json({
      success: true,
      data: (await config.autoNamed(unique)).map(mapper),
      stats: { original, duplicates: original - unique.length, unique: unique.length, geoUnlocated },
    });
  });

  // 手动触发重新检测未识别国家码（复用 prewarmIpGeo 批次+限流管线）
  // body: { scope?: 'unlocated' }，默认仅重检未识别项（省 ip-api 免费额度）
  app.post('/api/nodes/geo-redetect', async (c) => {
    const body = await readBody<{ scope?: string }>(c);
    const all = await repos.nodes.getAll();
    const unique = deduplicateNodes(all);
    const servers = [...new Set(unique.map((n) => n.server).filter((v): v is string => typeof v === 'string'))];
    // 1. 并发锁：同一次检测进行中返回 409
    const LOCK_KEY = 'geo_redetect_lock';
    const lockRaw = await repos.settings.get(LOCK_KEY);
    if (lockRaw) {
      try {
        const lock = JSON.parse(lockRaw) as { ts: number };
        if (Date.now() - lock.ts < 60 * 1000) {
          return c.json({ success: false, error: { code: 'GEO_SCAN_IN_PROGRESS', message: '检测已在进行中，请稍候' } }, 409);
        }
      } catch {
        // 锁格式异常视为可用
      }
    }
    await repos.settings.set(LOCK_KEY, JSON.stringify({ ts: Date.now() }));

    const ipGeoCache = { get: (k: string) => repos.settings.get(k), set: (k: string, v: string) => repos.settings.set(k, v) };
    // 2. 统计重检前未识别数（countUnlocatedGeo 返回的即未识别数）
    const unlocatedBefore = await config.countUnlocatedGeo(servers);
    // 3. 仅重检未识别项（默认 scope='unlocated'），全量则为所有 server
    const targets = body.scope === 'all' ? servers : await config.getUnlocatedServers(servers);
    let result = { total: 0, cached: 0, queried: 0, resolved: 0, failed: 0 };
    try {
      if (targets.length > 0) {
        result = await prewarmIpGeo(targets, ipGeoCache);
      }
    } finally {
      // 释放锁：settings 无 delete，用一个过期时间戳(旧)覆盖，锁检查依 TTL 判定为可用
      await repos.settings.set(LOCK_KEY, JSON.stringify({ ts: 0 }));
    }
    // 4. 统计重检后未识别数 + 列出仍未识别的 server（诊断用：域名/IP/保留段形态一眼可辨）
    const unlocatedAfter = await config.countUnlocatedGeo(servers);
    const unlocatedServers = (await config.getUnlocatedServers(servers)).slice(0, 50);
    // v2.25.0：重检后仍有未识别 IP → 激活 GeoRetry 门闩，由每分钟 cron 继续兜底重查
    try {
      await (await import('@/services/ip-geo.service')).activateGeoRetry(unlocatedAfter, repos.settings);
    } catch {
      // 激活失败不阻塞正常响应
    }
    return c.json({
      success: true,
      data: {
        total: result.total,
        cached: result.cached,
        queried: result.queried,
        resolved: result.resolved,
        failed: result.failed,
        unlocatedBefore: unlocatedBefore,
        unlocatedAfter,
        unlocatedServers,
      },
    });
  });

  // 读取未识别国家码自动重试的当前状态（v2.19.1，前端节点列表提示用）
  // 返回: { retryCount, unlocatedServers[] } —— 连续重试 10 次后仍剩的 IP 供界面提示「建议检查节点正确性」
  app.get('/api/nodes/geo-pending', async (c) => {
    const retryRaw = await repos.settings.get('geo_pending_retry');
    const resultRaw = await repos.settings.get('geo_pending_result');
    let retryCount = 0;
    let lastRetryTs: number | null = null;
    try {
      if (retryRaw) {
        const p = JSON.parse(retryRaw) as { count?: number; ts?: number };
        retryCount = p.count || 0;
        lastRetryTs = p.ts ?? null;
      }
    } catch {}
    let unlocatedServers: string[] = [];
    let resultTs: number | null = null;
    try {
      if (resultRaw) {
        const r = JSON.parse(resultRaw) as { unlocatedServers?: string[]; ts?: number };
        unlocatedServers = Array.isArray(r.unlocatedServers) ? r.unlocatedServers : [];
        resultTs = r.ts ?? null;
      }
    } catch {}
    return c.json({
      success: true,
      data: { retryCount, lastRetryTs, unlocatedServers, resultTs },
    });
  });

  // 设置节点启用状态（保存禁用列表）
  app.put('/api/nodes/enabled', async (c) => {
    const body = await readBody<{ enabled?: string[] }>(c);
    const enabled = Array.isArray(body.enabled) ? body.enabled : [];
    // 传入的是启用列表，反向存储为禁用列表
    const all = await repos.nodes.getAll();
    const allFingerprints = all.map((n) => nodeFingerprint(n));
    const enabledSet = new Set(enabled);
    const disabled = allFingerprints.filter((fp) => !enabledSet.has(fp));
    await config.setDisabledNodes(disabled);
    return c.json({ success: true, data: { disabledCount: disabled.length } });
  });

  // ============ Rule API ============

  // 获取规则列表
  app.get('/api/rules', async (c) => {
    const rules = await repos.rules.list();
    return c.json({ success: true, data: rules });
  });

  // 创建规则
  app.post('/api/rules', async (c) => {
    const body = await readBody<{ name?: string; type?: string; pattern?: string }>(c);
    if (!body.name || !body.type || !body.pattern) {
      throw ERRORS.INVALID_PARAMETER('name, type, pattern are required');
    }
    if (!['include', 'exclude', 'replace'].includes(body.type)) {
      throw ERRORS.INVALID_PARAMETER('type must be include|exclude|replace');
    }
    const rule = await repos.rules.create({
      name: body.name,
      type: body.type as 'include' | 'exclude' | 'replace',
      pattern: body.pattern,
    });
    return c.json({ success: true, data: { id: rule.id } }, 201);
  });

  // 删除规则
  app.delete('/api/rules/:id', async (c) => {
    const id = c.req.param('id');
    const deleted = await repos.rules.delete(id);
    if (!deleted) throw ERRORS.NOT_FOUND('Rule not found');
    return c.json({ success: true });
  });

  // ============ Dashboard API ============

  app.get('/api/dashboard', async (c) => {
    return c.json({ success: true, data: await buildDashboard() });
  });

  // ============ Output API ============

  // 通用配置输出：/api/output/{format}（需登录）
  // 支持: mihomo / singbox / v2ray / v2rayn / nekoray / shadowrocket
  app.get('/api/output/:format', requireAuth(auth), async (c) => {
    const format = c.req.param('format') ?? '';
    const allowedFormats = ['mihomo', 'singbox', 'v2ray', 'v2rayn', 'nekoray', 'shadowrocket'];
    if (!allowedFormats.includes(format)) {
      throw ERRORS.INVALID_PARAMETER('Unsupported format');
    }
    const result = await config.generateOutput(format as Parameters<typeof config.generateOutput>[0]);
    c.header('Content-Type', result.contentType);
    c.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    return c.body(result.content);
  });

  // ============ 订阅输出端点（无需登录，供客户端直接使用） ============

  // 获取持久订阅访问密钥（前端用它拼订阅链接）
  // 存 KV：首次生成，长期有效；不随 session 过期
  app.get('/api/sub-key', requireAuth(auth), async (c) => {
    let key = await repos.settings.get('sub_key');
    if (!key) {
      key = crypto.randomUUID();
      await repos.settings.set('sub_key', key);
    }
    return c.json({ success: true, data: { key } });
  });

  // 校验订阅访问令牌：
  // 1. 命中的是持久订阅 key（sub_key，推荐，客户端长期可用）
  // 2. 兼容旧版：命中的是 session token（仅浏览器会话内有效）
  async function validateSubToken(token: string): Promise<boolean> {
    if (!token) return false;
    const subKey = await repos.settings.get('sub_key');
    if (subKey && constantTimeEqual(token, subKey)) return true;
    // 兼容旧版 session token
    return auth.validateSession(token);
  }

  // 通用订阅端点：/sub/{format}/{token}
  // 支持: mihomo / singbox / v2ray / v2rayn / nekoray / shadowrocket
  app.get('/sub/:format/:token', async (c) => {
    const token = c.req.param('token') ?? '';
    const format = c.req.param('format') ?? '';
    const valid = await validateSubToken(token);
    if (!valid) {
      return c.json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Invalid token' } }, 401);
    }

    const allowedFormats = ['mihomo', 'singbox', 'v2ray', 'v2rayn', 'nekoray', 'shadowrocket'];
    if (!allowedFormats.includes(format)) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'Unsupported format' } }, 400);
    }

    const result = await config.generateOutput(format as Parameters<typeof config.generateOutput>[0]);
    return new Response(result.content, {
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    });
  });

  // ============ Rules API (分流规则) ============

  // 获取预定义规则大类（已合并用户自定义规则，前端规则页的数据源）
  app.get('/api/rules/groups', async (c) => {
    const groups = await config.getMergedGroups();
    return c.json({ success: true, data: { groups } });
  });

  // 获取规则分类目录（动态：KV 优先，KV 空回退内置 seed）
  // 供扫描/搜索/添加。可搜索 q 过滤、type 过滤、limit 截断。
  app.get('/api/rules/catalog', async (c) => {
    const { entries, fromKv } = await catalogSync.getCatalog();
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const typeFilter = (c.req.query('type') || '').trim().toLowerCase();
    const limit = Math.min(Number(c.req.query('limit') || 5000), 5000);
    let catalog = entries;
    if (typeFilter && ['aggregate', 'site', 'tld'].includes(typeFilter)) {
      catalog = catalog.filter((e) => e.type === typeFilter);
    }
    if (q) {
      catalog = catalog.filter((e) => e.id.toLowerCase().includes(q));
    }
    // 返回各类型计数，前端用于渲染 chips 徽标
    const typeCounts = {
      aggregate: entries.filter((e) => e.type === 'aggregate').length,
      site: entries.filter((e) => e.type === 'site').length,
      tld: entries.filter((e) => e.type === 'tld').length,
    };
    return c.json({
      success: true,
      data: {
        meta: { source: 'MetaCubeX/meta-rules-dat', total: entries.length, fromKv, typeCounts },
        catalog: catalog.slice(0, limit),
      },
    });
  });

  // 获取规则目录状态（需登录，含内部状态）
  app.get('/api/rules/catalog/meta', requireAuth(auth), async (c) => {
    const catalogMeta: RuleCatalogMeta = await repos.ruleCatalog.getMeta();
    return c.json({ success: true, data: { meta: catalogMeta } });
  });

  // 手动刷新规则库（需登录；触发一次扫描，失败时返回 stale 状态）
  app.post('/api/rules/catalog/refresh', requireAuth(auth), async (c) => {
    const result = await catalogSync.sync();
    if (result.status === 'stale') {
      return c.json({
        success: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: result.error ?? '上游不可达，已保留旧库' },
      }, 502);
    }
    return c.json({ success: true, data: { ...result } });
  });

  // 获取用户勾选的规则 id 列表
  app.get('/api/rules/selection', async (c) => {
    const ids = await config.getSelectedRuleIds();
    return c.json({ success: true, data: { ids } });
  });

  // 保存用户勾选的规则 id 列表
  app.put('/api/rules/selection', async (c) => {
    const body = await readBody<{ ids?: string[] }>(c);
    if (!Array.isArray(body.ids)) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'ids 必须为数组' } }, 400);
    }
    await config.setSelectedRuleIds(body.ids);
    return c.json({ success: true, data: { ids: body.ids } });
  });

  // 获取整组取消的规则大类 key 列表（v2.27.0 锁死模型）
  app.get('/api/rules/groups/disabled', async (c) => {
    const keys = await config.getDisabledGroupKeys();
    return c.json({ success: true, data: { keys } });
  });

  // 保存整组取消的规则大类 key 列表
  app.put('/api/rules/groups/disabled', async (c) => {
    const body = await readBody<{ keys?: string[] }>(c);
    if (!Array.isArray(body.keys)) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'keys 必须为数组' } }, 400);
    }
    await config.setDisabledGroupKeys(body.keys);
    return c.json({ success: true, data: { keys: body.keys } });
  });

  // 获取用户自定义规则列表
  app.get('/api/rules/custom', async (c) => {
    const rules = await config.getCustomRules();
    return c.json({ success: true, data: { rules } });
  });

  // 添加/更新一条自定义规则
  app.post('/api/rules/custom', async (c) => {
    const body = await readBody<{ id?: string; label?: string; groupKey?: string; target?: string }>(c);
    const id = (body.id || '').trim().toUpperCase();
    if (!id) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'id 不能为空' } }, 400);
    }
    // 规则 id 会流入属性/JS 字符串/RULE-SET 语法，限制字符集防止 XSS 与配置损坏
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(id)) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'id 仅允许字母、数字、-_，且不超过 64 字符' } }, 400);
    }
    const groupKey = (body.groupKey || 'user').trim();
    const target = (['PROXY', 'DIRECT', 'REJECT'].includes(body.target || '') ? body.target : 'PROXY') as 'PROXY' | 'DIRECT' | 'REJECT';
    const label = (body.label || id).trim();
    await config.upsertCustomRule({ id, label, groupKey, target });
    return c.json({ success: true, data: { id } });
  });

  // 删除一条自定义规则
  app.delete('/api/rules/custom/:id', async (c) => {
    const id = c.req.param('id').toUpperCase();
    await config.deleteCustomRule(id);
    return c.json({ success: true, data: { id } });
  });

  // ============ Settings ============

  app.get('/api/settings', requireAuth(auth), async (c) => {
    const appName = await repos.settings.get('app_name');
    const intervalRaw = await repos.settings.get('sub_update_interval');
    return c.json({
      success: true,
      data: {
        app_name: appName ?? 'SUB-Aggregation',
        sub_update_interval: intervalRaw !== null ? parseInt(intervalRaw, 10) : 24,
      },
    });
  });

  app.put('/api/settings', requireAuth(auth), async (c) => {
    const body = await readBody<{ app_name?: string; sub_update_interval?: number }>(c);
    if (body.app_name) {
      await repos.settings.set('app_name', body.app_name);
    }
    if (body.sub_update_interval !== undefined) {
      const h = Number(body.sub_update_interval);
      if (!Number.isInteger(h) || h < 0 || h > 24) {
        return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: '自动更新间隔须为 0-24 的整数（小时，0 = 不更新）' } }, 400);
      }
      await repos.settings.set('sub_update_interval', String(h));
    }
    return c.json({ success: true });
  });


  // 获取当前用户名
  app.get('/api/auth/username', requireAuth(auth), async (c) => {
    const username = await auth.getUsername();
    return c.json({ success: true, data: { username } });
  });

  // 修改用户名（需当前密码）
  app.post('/api/auth/username', requireAuth(auth), sensitiveOpRateLimit, async (c) => {
    const body = await readBody<{ currentPassword?: string; newUsername?: string }>(c);
    if (!body.currentPassword || !body.newUsername) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'currentPassword 和 newUsername 必填' } }, 400);
    }
    const ok = await auth.setUsername(body.currentPassword, body.newUsername);
    if (!ok) {
      return c.json({ success: false, error: { code: 'CHANGE_FAILED', message: '密码错误或用户名不合法（2-32位字母数字_-）' } }, 400);
    }
    return c.json({ success: true });
  });

  // 修改密码（需旧密码；成功后建议前端重新登录）
  app.post('/api/auth/password', requireAuth(auth), sensitiveOpRateLimit, async (c) => {
    const body = await readBody<{ currentPassword?: string; newPassword?: string }>(c);
    if (!body.currentPassword || !body.newPassword) {
      return c.json({ success: false, error: { code: 'INVALID_PARAMETER', message: 'currentPassword 和 newPassword 必填' } }, 400);
    }
    const ok = await auth.changePassword(body.currentPassword, body.newPassword);
    if (!ok) {
      return c.json({ success: false, error: { code: 'CHANGE_FAILED', message: '旧密码错误或新密码不足6位' } }, 400);
    }
    // 吊销当前 session，强制重新登录
    const token = getToken(c);
    if (token) await auth.logout(token);
    c.header('Set-Cookie', createClearCookie(isHttpsRequest(c)));
    return c.json({ success: true, data: { relogin: true } });
  });

  // ============ Operation Log API (v2.32) ============
  app.get('/api/operation-log', requireAuth(auth), async (c) => {
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    const { getOperationLogs } = await import('@/services/operation-log.service');
    const logs = await getOperationLogs(storage, limit);
    return c.json({ success: true, data: logs });
  });

  app.delete('/api/operation-log', requireAuth(auth), async (c) => {
    const { clearOperationLogs } = await import('@/services/operation-log.service');
    await clearOperationLogs(storage);
    return c.json({ success: true });
  });

  // ============ Nodes Health API (v2.32) ============
  app.get('/api/nodes/health', requireAuth(auth), async (c) => {
    const fingerprint = c.req.query('fingerprint');
    const { getNodeHealthHistory, getAllNodeHealth } = await import('@/services/node-probe.service');
    if (fingerprint) {
      const history = await getNodeHealthHistory(fingerprint, storage);
      return c.json({ success: true, data: history });
    }
    const health = await getAllNodeHealth(storage);
    return c.json({ success: true, data: health });
  });

  // v2.32: 前端「立即测活」按钮触发全量节点测活（同步等待，前端展示进度）
  app.post('/api/nodes/probe', requireAuth(auth), async (c) => {
    try {
      const { probeAllNodes } = await import('@/services/node-probe.service');
      const nodes = deduplicateNodes(await repos.nodes.getAll());
      const { stats } = await probeAllNodes(nodes, storage);
      return c.json({ success: true, nodeCount: nodes.length, stats });
    } catch (e) {
      return c.json({ success: false, error: { code: 'PROBE_FAILED', message: (e as Error).message } }, 500);
    }
  });

  // ============ 根路径（前端由 static 服务，后续实现） ============

  app.notFound((c) =>
    c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  );

  return app;
}