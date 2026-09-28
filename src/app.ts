/**
 * 共享应用层：Node 入口（src/server/main.ts）与测试共用。
 * 应用装配、前端响应、定时任务的逻辑只有这一份。
 */

import { Hono } from 'hono';
import { createApp } from '@/api/routes';
import { KVStorage, createRepositories } from '@/storage/kv';
import { createAuthService, createPasswordHash, ADMIN_USERNAME_KEY, DEFAULT_USERNAME } from '@/services/auth.service';
import { createSubscriptionService } from '@/services/subscription.service';
import { createConfigService } from '@/services/config.service';
import { createCatalogSyncService } from '@/services/catalog-sync.service';
import { deduplicateNodes } from '@/parser';
import { fetchSubscription } from '@/engine/fetcher';
import HTML from '@/html';

/** 运行时配置：来自 process.env（容器环境变量） */
export interface Env {
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  /** GitHub Personal Access Token（提升 API 限流至 5000/h，用于规则目录同步） */
  GITHUB_TOKEN?: string;
}

/**
 * 执行上下文：应用层只需要 waitUntil。
 * 入口传入等价 shim —— Hono v4 的 c.executionCtx
 * getter 在缺第三参时是 throw 而非返回 undefined，`?.` 防不住，必须实打实传进来。
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** 创建带 GitHub Token 的 fetcher（用于 rule-catalog 同步） */
function createCatalogFetcher(token?: string) {
  return (url: string) => {
    const headers: Record<string, string> = {};
    if (token && url.includes('api.github.com')) {
      // Fine-grained PAT 只认 Bearer，不认 token 前缀
      headers['Authorization'] = `Bearer ${token}`;
      headers['User-Agent'] = 'sub-aggregation';
    }
    return fetch(url, { headers }).then((r) => {
      if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`);
      return r.text();
    });
  };
}

export async function buildApp(kv: KVStorage, env: Env): Promise<Hono> {
  const repos = createRepositories(kv);

  // 首次部署初始化
  try {
    const existing = await kv.get('admin:hash');
    if (!existing && env.ADMIN_PASSWORD) {
      const { hash, salt } = await createPasswordHash(env.ADMIN_PASSWORD);
      await kv.put('admin:hash', JSON.stringify({ hash, salt }));
    }
    // 用户名初始化：旧部署自动补上默认 'admin'，不覆盖已有自定义用户名
    const existingUsername = await kv.get(ADMIN_USERNAME_KEY);
    if (!existingUsername) {
      await kv.put(ADMIN_USERNAME_KEY, DEFAULT_USERNAME);
    }
    // 密码版本号初始化（v2.21.0）：旧部署若无记录则写入版本 0
    const versionRaw = await kv.get('setting:password_version');
    if (!versionRaw) {
      await kv.put('setting:password_version', '0');
    }
  } catch (err) {
    console.error('Failed to initialize admin password:', (err as Error).message);
  }

  const auth = createAuthService(repos.sessions, async () => {
    const raw = await kv.get('admin:hash');
    if (raw) {
      try { return JSON.parse(raw) as { hash: string; salt: string }; } catch { return null; }
    }
    return null;
  }, { get: (key) => kv.get(key), put: (key, value) => kv.put(key, value) });

  const subscriptions = createSubscriptionService(
    repos,
    fetchSubscription,
    async () => (await repos.rules.list()).map((r) => ({ type: r.type, pattern: r.pattern, enabled: r.enabled })),
    kv
  );

  const config = createConfigService(repos, kv);

  // 规则目录同步服务（供 scheduled handler + API 共用）
  const catalogSync = createCatalogSyncService(repos, createCatalogFetcher(env.GITHUB_TOKEN));

  return createApp({
    repos, auth, subscriptions, config,
    adminPassword: env.ADMIN_PASSWORD ?? '',
    fetchRaw: fetchSubscription,
    parseContent: async () => [],
    catalogSync,
    storage: kv,
  });
}

// 缓存应用实例
let appPromise: Promise<Hono> | null = null;

/** 取应用实例（首次调用装配，之后复用） */
export function getApp(kv: KVStorage, env: Env): Promise<Hono> {
  if (!appPromise) appPromise = buildApp(kv, env);
  return appPromise;
}

/** 读取前端 HTML 的 ETag（内容哈希，模块级只计算一次） */
let htmlEtagPromise: Promise<string> | null = null;
function getHtmlEtag(): Promise<string> {
  if (!htmlEtagPromise) {
    htmlEtagPromise = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(HTML))
      .then(
        (buf) =>
          `"${Array.from(new Uint8Array(buf, 0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}"`
      );
  }
  return htmlEtagPromise;
}

/**
 * 预压缩的 HTML：首次请求时压一次，常驻内存。
 * 页面响应由入口直接返回（handleHtml 在 app.fetch 之前短路），
 * 走不到 Hono 的 compress() 中间件，所以这里自己压。
 */
let htmlGzipPromise: Promise<Uint8Array> | null = null;
function getHtmlGzip(): Promise<Uint8Array> {
  if (!htmlGzipPromise) {
    htmlGzipPromise = new Response(
      new Blob([HTML]).stream().pipeThrough(new CompressionStream('gzip'))
    )
      .arrayBuffer()
      .then((buf) => new Uint8Array(buf));
  }
  return htmlGzipPromise;
}

/**
 * 前端页面：非 API 和非 /sub 请求返回 HTML，带内容哈希 ETag（二次访问命中 304，
 * 省掉约 105KB 传输；内容变了 ETag 自动变，不会读到旧页面）。
 * 客户端支持 gzip 时返回预压缩体（107KB → 约 20KB），ETag 加 `-gzip` 后缀区分两种表示。
 * 返回 null 表示不是页面请求，交给 API 路由。
 */
export async function handleHtml(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sub/')) return null;

  const gzip = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
  const base = await getHtmlEtag(); // "xxxx"（带引号的 32 位十六进制）
  const etag = gzip ? `${base.slice(0, -1)}-gzip"` : base;
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    Vary: 'Accept-Encoding',
    ETag: etag,
  };
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (gzip) {
    headers['Content-Encoding'] = 'gzip';
    return new Response(await getHtmlGzip(), { headers });
  }
  return new Response(HTML, { headers });
}

/**
 * 订阅自动更新是否到点。
 * 间隔单位小时，取值 1-24；0 或非法值 = 不更新。
 * 判定按整点 tick 做，留 1 分钟余量：否则 24 小时的间隔每逢整点会差几毫秒，
 * 天天空过一次、顺延成 25 小时并持续漂移。
 */
export function isSubAutoUpdateDue(intervalHours: number, lastAtMs: number, nowMs: number): boolean {
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) return false;
  return nowMs - lastAtMs >= intervalHours * 3_600_000 - 60_000;
}

/** 定时任务：每月 1 号 03:00 UTC 规则目录同步；按用户设定间隔（默认 24 小时）自动更新全部订阅 */
export async function runScheduled(
  cron: string,
  scheduledTime: number,
  kv: KVStorage,
  env: Env
): Promise<void> {
  const repos = createRepositories(kv);

  // 每月 1 号规则目录同步
  if (cron === '0 3 1 * *') {
    const catalogSync = createCatalogSyncService(repos, createCatalogFetcher(env.GITHUB_TOKEN));
    const result = await catalogSync.sync();
    if (result.status === 'stale') {
      console.warn(`[CatalogSync] 扫描失败: ${result.error}`);
    } else {
      console.warn(`[CatalogSync] 扫描完成: ${result.total} 个分类, 新增 ${result.added.length}, 移除 ${result.removed.length}`);
    }
    return;
  }

  // 每分钟未识别国家码自动重试（v2.19.1）：发现未识别 IP 全量批量重查，连续重试 10 次后停止并提示检查节点
  // v2.25.0：任务门闩（active 哨兵）——正常态（无未识别 IP）直接短路，0 KV 写，不再每分钟跑全量/写归零状态
  if (cron === '* * * * *') {
    try {
      const { prewarmIpGeo, filterUnlocatedServers, getGeoRetryGate, setGeoRetryGate, deactivateGeoRetry, GEO_RETRY_MAX } = await import('@/services/ip-geo.service');
      const ipGeoCache = { get: (k: string): Promise<string | null> => repos.settings.get(k), set: (k: string, v: string) => repos.settings.set(k, v) };

      // ① 门闩短路：无激活重试任务 → 直接 return（0 KV 写，不跑 getAll、不查 IP）
      const gate = await getGeoRetryGate(repos.settings);
      if (!gate.active) return;

      const allNodes = deduplicateNodes(await repos.nodes.getAll());
      const servers = [...new Set(allNodes.map((n) => n.server).filter((v): v is string => typeof v === 'string'))];
      if (servers.length === 0) {
        await deactivateGeoRetry(repos.settings);
        return;
      }
      const unlocated = await filterUnlocatedServers(servers, ipGeoCache);

      if (unlocated.length === 0) {
        // 全部已识别：关闭门闩，回到 0 KV 写睡眠态
        await deactivateGeoRetry(repos.settings);
        await repos.settings.set('geo_pending_result', JSON.stringify({ ts: Date.now(), unlocatedServers: [] }));
        return;
      }

      if (gate.count >= GEO_RETRY_MAX) {
        // 连续 N 次仍有未识别：关闭门闩停止重试，记录剩余 IP 供界面提示「建议检查节点正确性」
        await deactivateGeoRetry(repos.settings);
        await repos.settings.set('geo_pending_result', JSON.stringify({ ts: Date.now(), unlocatedServers: unlocated }));
        return;
      }

      // 全量批量重查（batchQuery 内部 15 次/分钟限流兜底，未识别 IP 全在池子里一次查完）
      const res = await prewarmIpGeo(unlocated, ipGeoCache);
      const after = await filterUnlocatedServers(servers, ipGeoCache);
      await setGeoRetryGate(repos.settings, { ts: Date.now(), count: gate.count + 1, active: true });
      if (after.length === 0) {
        // 本次查完清零并关闭门闩
        await deactivateGeoRetry(repos.settings);
        await repos.settings.set('geo_pending_result', JSON.stringify({ ts: Date.now(), unlocatedServers: [] }));
        return;
      }
      // 仍有残留：更新提示结果（界面实时可见剩余 IP），保持 active 继续下一分钟重试
      await repos.settings.set('geo_pending_result', JSON.stringify({ ts: Date.now(), unlocatedServers: after }));
      console.warn(`[GeoRetry] 第${gate.count + 1}次重试: 查${res.queried} 剩${after.length}`);
    } catch (e) {
      console.warn(`[GeoRetry] 重试失败(不阻塞): ${(e as Error).message}`);
    }
    return;
  }

  // 订阅自动更新（设置页 sub_update_interval：间隔小时数 1-24，0 = 不更新，默认 24）
  // v2.31.2：由「每天固定时刻」改为「每隔 N 小时」，时间戳落 sub_update_last_at
  const now = scheduledTime || Date.now();
  const parsedInterval = Number.parseInt((await repos.settings.get('sub_update_interval')) ?? '', 10);
  const interval = Number.isInteger(parsedInterval) ? parsedInterval : 24;
  const lastAt = Number((await repos.settings.get('sub_update_last_at')) ?? 0);
  if (!isSubAutoUpdateDue(interval, lastAt, now)) return;

  const subs = createSubscriptionService(
    repos,
    fetchSubscription,
    async () => (await repos.rules.list()).map((r) => ({ type: r.type, pattern: r.pattern, enabled: r.enabled })),
    kv
  );
  const results: string[] = [];
  for (const s of await subs.list()) {
    // 停用的订阅不参与自动更新（用户 2026-09-24）
    if (!s.enabled) {
      results.push(`${s.name}:已停用`);
      continue;
    }
    try {
      const { nodeCount } = await subs.update(s.id, fetchSubscription);
      results.push(`${s.name}:${nodeCount}节点`);
    } catch (e) {
      results.push(`${s.name}:失败(${(e as Error).message})`);
    }
  }
  // 记下本次自动更新的时刻（无论个别订阅成败），下一次间隔从这个点开始算
  await repos.settings.set('sub_update_last_at', String(now));

  // v2.32: 订阅更新完成后，触发节点测活引擎（全量扫描）
  // 异步执行，不阻塞订阅更新流程
  try {
    const { probeAllNodes } = await import('@/services/node-probe.service');
    const allNodes = deduplicateNodes(await repos.nodes.getAll());
    // 后台触发，不等待结果
    probeAllNodes(allNodes, kv).catch((e) => {
      console.warn(`[SubAutoUpdate] 节点测活触发失败(后台,不阻塞): ${(e as Error).message}`);
    });
  } catch (e) {
    console.warn(`[SubAutoUpdate] 节点测活模块加载失败: ${(e as Error).message}`);
  }

  // 主动预填充 IP 地理缓存：全部订阅更新后，批量查一遍 server 归属地
  // v2.25.0：cache 统一走 repos.settings（setting: 前缀，与手动更新/前端统计同口径）；
  //          预热后若有未识别 IP 则激活 GeoRetry 门闩，唤醒每分钟 cron 继续重查
  try {
    const { prewarmIpGeo, filterUnlocatedServers, activateGeoRetry } = await import('@/services/ip-geo.service');
    const allNodes = deduplicateNodes(await repos.nodes.getAll());
    const servers = [...new Set(allNodes.map((n) => n.server).filter((v): v is string => typeof v === 'string'))];
    if (servers.length > 0) {
      const ipGeoCache = { get: (k: string) => repos.settings.get(k), set: (k: string, v: string) => repos.settings.set(k, v) };
      const geoResult = await prewarmIpGeo(servers, ipGeoCache);
      const unlocated = await filterUnlocatedServers(servers, ipGeoCache);
      await activateGeoRetry(unlocated.length, repos.settings);
      console.warn(`[SubAutoUpdate] IP地理预填充完成: 总数 ${geoResult.total}，已缓存 ${geoResult.cached}，新查 ${geoResult.queried}，解析成功 ${geoResult.resolved}，失败 ${geoResult.failed}，剩余未识别 ${unlocated.length}`);
    }
  } catch (e) {
    console.warn(`[SubAutoUpdate] IP地理预填充失败(不阻塞): ${(e as Error).message}`);
  }
  console.warn(`[SubAutoUpdate] 订阅自动更新完成: ${results.join(', ')}`);
}
