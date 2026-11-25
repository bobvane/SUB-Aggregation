/**
 * mihomo 核心探测服务（v2.50.0）
 *
 * 用官方 mihomo 核心做真实端到端测速：
 *   启动一个临时 mihomo（极简配置：proxies + mixed + external-controller）
 *   → 逐个节点调 `GET /proxies/<name>/delay?url=...`
 *   → 测完退出。
 *
 * 不依赖 TCP/TLS 握手；Hysteria2 / TUIC / WireGuard / AnyTLS / SSR 等
 * 所有本项目支持的协议都由核心真实穿透测试。
 *
 * 核心二进制来源：
 *   - 镜像内置：/app/core/mihomo（Docker 构建时从 metacubex/mihomo 镜像 COPY）
 *   - 运行时升级：/data/core/mihomo（优先使用，持久化）
 *   - 本地调试：CORE_PATH 环境变量
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Node, nodeFingerprint } from '@/models/node';
import { nodeToMihomoProxy } from '@/generator/mihomo';
import { generateYaml } from '@/generator/yaml-serializer';

/** 设置键：核心延迟抛弃阈值（毫秒） */
export const CORE_DROP_LATENCY_KEY = 'core_drop_latency_ms';
/** 核心延迟抛弃阈值默认值（毫秒）：核心 HTTP 延迟通常高于 TCP/TLS RTT */
export const DEFAULT_CORE_DROP_LATENCY_MS = 3000;
/** 设置键：测速测试 URL 列表（JSON 数组） */
export const CORE_TEST_URLS_KEY = 'core_test_urls';
/** 默认测试 URL（多路 fallback；只用 204/200 小响应，省带宽） */
export const DEFAULT_CORE_TEST_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204',
  'https://www.apple.com/library/test/success.html',
];
/** 全量测速周期：6 小时；其余时间只测新增/变化节点 */
export const CORE_FULL_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 单节点单 URL 超时（毫秒） */
export const CORE_PROBE_TIMEOUT_MS = 5000;
/** 并发节点数 */
export const CORE_PROBE_CONCURRENCY = 16;
/** 单个 mihomo 实例最多加载多少节点（限制配置/内存） */
export const CORE_PROBE_CHUNK_SIZE = 100;

export interface CoreProbeOptions {
  testUrls?: string[];
  timeoutMs?: number;
  concurrency?: number;
  chunkSize?: number;
  corePath?: string;
}

export interface CoreProbeOutcome {
  nodeId: string;
  fingerprint: string;
  /** 核心 HTTP 延迟（毫秒）；null = 失败 */
  latency: number | null;
  status: 'alive' | 'dead' | 'unknown';
  error: string | null;
  timestamp: number;
}

export interface CoreProbeBatchResult {
  outcomes: CoreProbeOutcome[];
  /** 核心是否可用（启动/controller 正常）。false 时 outcomes 多为 unknown，不应写健康数据 */
  coreOk: boolean;
  error: string | null;
}

let cachedVersion: string | null | undefined;

/** 解析当前使用的核心二进制路径（优先 /data 升级版，其次镜像内置） */
export function resolveCorePath(): string | null {
  const candidates = [
    process.env.CORE_PATH,
    '/data/core/mihomo',
    '/app/core/mihomo',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 读取核心版本（`mihomo -v`），结果缓存；升级后调用 invalidateCoreVersionCache() */
export async function getCoreVersion(force = false): Promise<string | null> {
  if (!force && cachedVersion !== undefined) return cachedVersion;
  const path = resolveCorePath();
  if (!path) {
    cachedVersion = null;
    return null;
  }
  const version = await new Promise<string | null>((resolve) => {
    execFile(path, ['-v'], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = `${stdout}\n${stderr}`.trim();
      const m = out.match(/v?(\d+\.\d+\.\d+[^\s]*)/i);
      resolve(m ? m[1] : (out.split('\n')[0] || null));
    });
  });
  cachedVersion = version;
  return version;
}

export function invalidateCoreVersionCache(): void {
  cachedVersion = undefined;
}

/** 当前正在运行的测速核心进程（升级时先停掉） */
let activeChild: ChildProcess | null = null;

export function stopActiveCore(): void {
  const child = activeChild;
  if (!child) return;
  activeChild = null;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 1500);
}

/** 申请一个本地空闲端口 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 等待 mihomo controller 就绪 */
async function waitForController(port: number, secret: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/version`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 通过核心测单个节点：按 URL 顺序 fallback，首个成功即返回 */
async function testOne(
  port: number,
  secret: string,
  name: string,
  urls: string[],
  timeoutMs: number
): Promise<{ latency: number | null; error: string | null }> {
  let lastError = '未测试';
  for (const url of urls) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`,
        {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(timeoutMs + 2000),
        }
      );
      const data = (await res.json().catch(() => ({}))) as { delay?: unknown; message?: unknown };
      if (res.ok && typeof data.delay === 'number' && Number.isFinite(data.delay) && data.delay > 0) {
        return { latency: Math.round(data.delay), error: null };
      }
      lastError = typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { latency: null, error: lastError };
}

/** 运行一个 mihomo 实例并测完这一批节点 */
async function runChunk(
  nodes: Node[],
  settings: { testUrls: string[]; timeoutMs: number; concurrency: number },
  corePath: string
): Promise<CoreProbeOutcome[]> {
  const controllerPort = await getFreePort();
  const mixedPort = await getFreePort();
  const secret = randomBytes(16).toString('hex');
  const home = join(
    tmpdir(),
    `mihomo-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const configPath = join(home, 'config.yaml');
  mkdirSync(home, { recursive: true });

  const proxies = nodes.map((n, i) => ({ ...nodeToMihomoProxy(n), name: `n${i}` }));
  writeFileSync(
    configPath,
    generateYaml({
      'mixed-port': mixedPort,
      'allow-lan': false,
      mode: 'global',
      'log-level': 'silent',
      'external-controller': `127.0.0.1:${controllerPort}`,
      secret,
      proxies,
    }),
    'utf8'
  );

  const child = spawn(corePath, ['-f', configPath, '-d', home], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  activeChild = child;
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += String(d);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    const ready = await waitForController(controllerPort, secret, 8000);
    if (!ready || exited) {
      const err = stderr.trim() || '测速核心启动失败';
      const ts = Date.now();
      return nodes.map((n) => ({
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        latency: null,
        status: 'unknown' as const,
        error: err,
        timestamp: ts,
      }));
    }

    const outcomes: CoreProbeOutcome[] = [];
    let index = 0;
    const worker = async () => {
      while (true) {
        const i = index++;
        if (i >= nodes.length) return;
        const n = nodes[i];
        const r = await testOne(controllerPort, secret, `n${i}`, settings.testUrls, settings.timeoutMs);
        outcomes.push({
          nodeId: n.id,
          fingerprint: nodeFingerprint(n),
          latency: r.latency,
          status: r.latency !== null ? 'alive' : 'dead',
          error: r.error,
          timestamp: Date.now(),
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(settings.concurrency, nodes.length) }, () => worker())
    );
    return outcomes;
  } finally {
    activeChild = null;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 1500);
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * 用 mihomo 核心测一批节点。
 * 分批执行（默认 100/批），单批核心启动失败时该批标记 unknown，不误判 dead。
 */
export async function probeWithCore(
  nodes: Node[],
  opts: CoreProbeOptions = {}
): Promise<CoreProbeBatchResult> {
  const corePath = opts.corePath ?? resolveCorePath();
  if (!corePath) {
    const ts = Date.now();
    return {
      outcomes: nodes.map((n) => ({
        nodeId: n.id,
        fingerprint: nodeFingerprint(n),
        latency: null,
        status: 'unknown' as const,
        error: '测速核心未安装（缺少 mihomo 二进制）',
        timestamp: ts,
      })),
      coreOk: false,
      error: '测速核心未安装',
    };
  }
  if (nodes.length === 0) {
    return { outcomes: [], coreOk: true, error: null };
  }

  const urls = (opts.testUrls && opts.testUrls.length > 0 ? opts.testUrls : DEFAULT_CORE_TEST_URLS)
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  const settings = {
    testUrls: urls.length > 0 ? urls : DEFAULT_CORE_TEST_URLS,
    timeoutMs: opts.timeoutMs ?? CORE_PROBE_TIMEOUT_MS,
    concurrency: Math.max(1, opts.concurrency ?? CORE_PROBE_CONCURRENCY),
  };
  const chunkSize = Math.max(1, opts.chunkSize ?? CORE_PROBE_CHUNK_SIZE);

  const outcomes: CoreProbeOutcome[] = [];
  let coreOk = true;
  let lastError: string | null = null;

  for (let i = 0; i < nodes.length; i += chunkSize) {
    const chunk = nodes.slice(i, i + chunkSize);
    try {
      const part = await runChunk(chunk, settings, corePath);
      outcomes.push(...part);
      const failed = part.find((o) => o.status === 'unknown');
      if (failed) {
        coreOk = false;
        lastError = failed.error ?? lastError;
      }
    } catch (e) {
      coreOk = false;
      lastError = (e as Error).message;
      const ts = Date.now();
      outcomes.push(
        ...chunk.map((n) => ({
          nodeId: n.id,
          fingerprint: nodeFingerprint(n),
          latency: null,
          status: 'unknown' as const,
          error: lastError,
          timestamp: ts,
        }))
      );
    }
  }

  return { outcomes, coreOk, error: lastError };
}

// ===== 测试注入点：单元测试可用假 runner 替代真实 mihomo 进程 =====
export type CoreProbeRunner = (
  nodes: Node[],
  opts?: CoreProbeOptions
) => Promise<CoreProbeBatchResult>;

let testRunner: CoreProbeRunner | null = null;

export function setCoreProbeRunnerForTest(fn: CoreProbeRunner | null): void {
  testRunner = fn;
}

export function runCoreProbe(
  nodes: Node[],
  opts?: CoreProbeOptions
): Promise<CoreProbeBatchResult> {
  return (testRunner ?? probeWithCore)(nodes, opts);
}
