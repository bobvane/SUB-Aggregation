/**
 * WARP 端点发现 + 存活验证（独立模块，v2.50.4）
 *
 * 做法参考 xehn 的思路（不复制其代码）：
 *   - 候选不是一份会过期的 IP 清单，而是「已知网段 + 采样」；
 *   - 用 mihomo 核心真实建链（H2 = TCP/443，H3 = QUIC/443），
 *     通过 `/proxies/<name>/delay` 发起真实 HTTP 请求；
 *   - 单次失败不可信，重试 3 次；
 *   - 结果分「存活 / 失败 / 不确定」，只把存活的交给页面生成节点。
 *
 * 隔离约定：
 *   - 不 import config.service / node-probe / models/node；
 *   - 不读写 nodes:* / health:* / settings:*；
 *   - 只由 warp-lab 路由调用，任务状态仅在内存与 warp_lab:last_scan 中。
 *
 * 视角说明（重要）：
 *   验证是从「运行本项目的这台机器」发起的。若项目部署在境外 VPS，
 *   这里只能证明端点「活着、能握手、能传数据」，不能证明「中国墙内可用」。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { generateYaml } from '@/generator/yaml-serializer';
import { WARP_LAB_DEFAULT_SNI, type WarpLabAccount } from '@/services/warp-lab.service';

/**
 * 本模块自带核心路径解析，避免依赖 core-probe.service（进而依赖 models/node）。
 * 这样删除 WARP 实验页时，本文件可以整块删掉，不牵动节点链路。
 */
function resolveCorePath(): string | null {
  const candidates = [process.env.CORE_PATH, '/data/core/mihomo', '/app/core/mihomo'].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** H3 的固定候选：xehn 实测只有 198.1/.2 可用；199.1/.2 一并验证，避免照搬结论 */
export const WARP_SCAN_H3_IPS = [
  '162.159.198.1',
  '162.159.198.2',
  '162.159.199.1',
  '162.159.199.2',
];

/** H2 的两个 /24（H2 覆盖面比 H3 宽，采样即可） */
export const WARP_SCAN_H2_SUBNETS = ['162.159.198', '162.159.199'];

/** xehn 使用的 MASQUE 端口集合 */
export const WARP_SCAN_PORTS = [443, 500, 1701, 4500, 4443, 8443, 8095];
export const WARP_SCAN_DEFAULT_PORTS = [443];

export const WARP_SCAN_DEFAULT_SAMPLE = 8;
export const WARP_SCAN_MAX_COMBOS = 150;
export const WARP_SCAN_CONCURRENCY = 3;
export const WARP_SCAN_ATTEMPTS = 3;
export const WARP_SCAN_TIMEOUT_MS = 5000;
export const WARP_SCAN_TEST_URL = 'https://www.gstatic.com/generate_204';
export const WARP_SCAN_LAST_KEY = 'warp_lab:last_scan';
const WARP_SCAN_JOB_TTL_MS = 30 * 60 * 1000;

export type WarpTransport = 'h2' | 'h3';
export type WarpScanState = 'running' | 'success' | 'failed' | 'cancelled';
export type WarpScanStatus = 'alive' | 'failed' | 'unknown';

export interface WarpScanCandidate {
  server: string;
  port: number;
  transport: WarpTransport;
}

export interface WarpScanResult extends WarpScanCandidate {
  status: WarpScanStatus;
  latency: number | null;
  error: string | null;
  attempts: number;
}

export interface WarpScanOptions {
  protocols?: WarpTransport[];
  ports?: number[];
  samplePerSubnet?: number;
  /** 自检：固定 4 个 IP × {h2,h3} × 443，共 8 组 */
  selfcheck?: boolean;
  /** TLS SNI；缺省用官方默认值 */
  sni?: string;
}

export interface WarpScanJobPublic {
  id: string;
  state: WarpScanState;
  mode: 'scan' | 'selfcheck';
  total: number;
  processed: number;
  alive: number;
  failed: number;
  unknown: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  results: WarpScanResult[];
}

interface WarpScanJob extends WarpScanJobPublic {
  candidates: WarpScanCandidate[];
  sni: string;
  cancelRequested: boolean;
}

export interface WarpScanRunnerContext {
  sni: string;
  shouldStop: () => boolean;
  onResult: (result: WarpScanResult) => void;
}

export type WarpScanRunner = (
  account: WarpLabAccount,
  candidates: WarpScanCandidate[],
  ctx: WarpScanRunnerContext
) => Promise<{ coreOk: boolean; error: string | null }>;

export interface WarpScanHooks {
  onFinish?: (job: WarpScanJobPublic) => void | Promise<void>;
}

const jobs = new Map<string, WarpScanJob>();
let activeJobId: string | null = null;
let activeWarpChild: ChildProcess | null = null;
let testRunner: WarpScanRunner | null = null;

function normalizeProtocols(input: WarpTransport[] | undefined): WarpTransport[] {
  const fallback: WarpTransport[] = ['h2', 'h3'];
  const list = (Array.isArray(input) && input.length > 0 ? input : fallback).filter(
    (p): p is WarpTransport => p === 'h2' || p === 'h3'
  );
  const out: WarpTransport[] = [];
  for (const p of list) if (!out.includes(p)) out.push(p);
  return out.length > 0 ? out : fallback;
}

function normalizePorts(input: number[] | undefined): number[] {
  const list = Array.isArray(input) && input.length > 0 ? input : WARP_SCAN_DEFAULT_PORTS;
  const out: number[] = [];
  for (const raw of list) {
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !out.includes(port)) out.push(port);
  }
  return out.length > 0 ? out : [443];
}

function sampleHosts(
  subnet: string,
  count: number,
  rand: (maxExclusive: number) => number
): string[] {
  const total = 254;
  const want = Math.max(0, Math.min(total, Math.floor(count)));
  if (want === 0) return [];
  const picked = new Set<number>();
  if (want >= total) {
    for (let i = 1; i <= total; i++) picked.add(i);
  } else {
    while (picked.size < want) picked.add(1 + rand(total));
  }
  return [...picked].sort((a, b) => a - b).map((n) => `${subnet}.${n}`);
}

/**
 * 生成候选组合。纯函数，便于测试。
 * 自检模式忽略端口/采样，只测固定 4 个 IP × {h2,h3} × 443。
 */
export function buildWarpScanCandidates(
  opts: WarpScanOptions = {},
  rand: (maxExclusive: number) => number = (n) => randomInt(n)
): WarpScanCandidate[] {
  const out: WarpScanCandidate[] = [];
  const seen = new Set<string>();
  const add = (server: string, port: number, transport: WarpTransport) => {
    const key = `${transport}:${server}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ server, port, transport });
  };

  if (opts.selfcheck) {
    for (const transport of ['h2', 'h3'] as WarpTransport[]) {
      for (const ip of WARP_SCAN_H3_IPS) add(ip, 443, transport);
    }
    return out;
  }

  const protocols = normalizeProtocols(opts.protocols);
  const ports = normalizePorts(opts.ports);
  const sample = Math.max(
    1,
    Math.min(254, Math.floor(Number(opts.samplePerSubnet ?? WARP_SCAN_DEFAULT_SAMPLE) || WARP_SCAN_DEFAULT_SAMPLE))
  );

  for (const transport of protocols) {
    if (transport === 'h3') {
      for (const ip of WARP_SCAN_H3_IPS) {
        for (const port of ports) add(ip, port, 'h3');
      }
      continue;
    }
    for (const subnet of WARP_SCAN_H2_SUBNETS) {
      for (const host of sampleHosts(subnet, sample, rand)) {
        for (const port of ports) add(host, port, 'h2');
      }
    }
  }

  if (out.length > WARP_SCAN_MAX_COMBOS) {
    throw new Error(
      `组合数过多（${out.length}），请减少端口或采样数（上限 ${WARP_SCAN_MAX_COMBOS}）`
    );
  }
  return out;
}

function publicJob(job: WarpScanJob): WarpScanJobPublic {
  return {
    id: job.id,
    state: job.state,
    mode: job.mode,
    total: job.total,
    processed: job.processed,
    alive: job.alive,
    failed: job.failed,
    unknown: job.unknown,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    results: job.results,
  };
}

function pruneJobs(): void {
  const cutoff = Date.now() - WARP_SCAN_JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.startedAt < cutoff) jobs.delete(id);
  }
}

/** 启动一次扫描；立即返回任务快照，实际验证在后台进行 */
export function startWarpScan(
  account: WarpLabAccount,
  opts: WarpScanOptions = {},
  hooks: WarpScanHooks = {}
): WarpScanJobPublic {
  const current = activeJobId ? jobs.get(activeJobId) : undefined;
  if (current && current.state === 'running') {
    throw new Error('已有端点验证任务在运行，请等待完成或取消');
  }
  const candidates = buildWarpScanCandidates(opts);
  const sni = String(opts.sni ?? '').trim() || WARP_LAB_DEFAULT_SNI;
  const job: WarpScanJob = {
    id: randomBytes(8).toString('hex'),
    state: 'running',
    mode: opts.selfcheck ? 'selfcheck' : 'scan',
    total: candidates.length,
    processed: 0,
    alive: 0,
    failed: 0,
    unknown: 0,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    results: [],
    candidates,
    sni,
    cancelRequested: false,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  pruneJobs();
  void runJob(job, account, hooks);
  return publicJob(job);
}

export function getWarpScanJob(id: string): WarpScanJobPublic | null {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function cancelWarpScanJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.state !== 'running') return false;
  job.cancelRequested = true;
  stopActiveWarpCore();
  return true;
}

async function runJob(job: WarpScanJob, account: WarpLabAccount, hooks: WarpScanHooks): Promise<void> {
  const runner = testRunner ?? runWithCore;
  try {
    const out = await runner(account, job.candidates, {
      sni: job.sni,
      shouldStop: () => job.cancelRequested,
      onResult: (result) => {
        job.results.push(result);
        job.processed = job.results.length;
        if (result.status === 'alive') job.alive++;
        else if (result.status === 'failed') job.failed++;
        else job.unknown++;
      },
    });
    if (job.cancelRequested) job.state = 'cancelled';
    else if (!out.coreOk) {
      job.state = 'failed';
      job.error = out.error ?? '测速核心不可用';
    } else job.state = 'success';
  } catch (e) {
    job.state = 'failed';
    job.error = (e as Error).message;
  } finally {
    job.finishedAt = Date.now();
    if (activeJobId === job.id) activeJobId = null;
    try {
      await hooks.onFinish?.(publicJob(job));
    } catch {
      // 持久化失败不影响任务结果
    }
  }
}

// ===== 真实执行：一个 mihomo 核心 + N 个代理条目 =====

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

async function testOne(
  port: number,
  secret: string,
  name: string,
  url: string,
  timeoutMs: number
): Promise<{ latency: number | null; error: string | null }> {
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
    return {
      latency: null,
      error: typeof data.message === 'string' ? data.message : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { latency: null, error: (e as Error).message };
  }
}

function buildMasqueProxy(
  account: WarpLabAccount,
  candidate: WarpScanCandidate,
  name: string,
  sni: string
): Record<string, unknown> {
  const proxy: Record<string, unknown> = {
    name,
    type: 'masque',
    server: candidate.server,
    port: candidate.port,
    sni,
    'private-key': account.privateKey,
    'public-key': account.peerPublicKey,
    'congestion-controller': 'bbr',
    'ip-stack': { mode: 'gvisor' },
    'handshake-timeout': 5,
    udp: true,
  };
  if (account.ipv4) proxy.ip = account.ipv4;
  if (account.ipv6) proxy.ipv6 = account.ipv6;
  if (candidate.transport === 'h2') proxy.network = 'h2';
  return proxy;
}

function stopActiveWarpCore(): void {
  const child = activeWarpChild;
  if (!child) return;
  activeWarpChild = null;
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

async function runWithCore(
  account: WarpLabAccount,
  candidates: WarpScanCandidate[],
  ctx: WarpScanRunnerContext
): Promise<{ coreOk: boolean; error: string | null }> {
  const corePath = resolveCorePath();
  if (!corePath) {
    const error = '测速核心未安装（缺少 mihomo 二进制）';
    for (const c of candidates) {
      ctx.onResult({ ...c, status: 'unknown', latency: null, error, attempts: 0 });
    }
    return { coreOk: false, error };
  }

  let home = '';
  let child: ChildProcess | null = null;
  try {
    const controllerPort = await getFreePort();
    const mixedPort = await getFreePort();
    const secret = randomBytes(16).toString('hex');
    home = join(
      tmpdir(),
      `mihomo-warp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(home, { recursive: true });
    const configPath = join(home, 'config.yaml');
    const proxies = candidates.map((c, i) => buildMasqueProxy(account, c, `w${i}`, ctx.sni));
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

    child = spawn(corePath, ['-f', configPath, '-d', home], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeWarpChild = child;
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    const ready = await waitForController(controllerPort, secret, 8000);
    if (!ready || exited) {
      const error = stderr.trim() || '测速核心启动失败';
      for (const c of candidates) {
        ctx.onResult({ ...c, status: 'unknown', latency: null, error, attempts: 0 });
      }
      return { coreOk: false, error };
    }

    let index = 0;
    const worker = async () => {
      while (!ctx.shouldStop()) {
        const i = index++;
        if (i >= candidates.length) return;
        const candidate = candidates[i];
        let latency: number | null = null;
        let error: string | null = null;
        let attempts = 0;
        for (let attempt = 0; attempt < WARP_SCAN_ATTEMPTS; attempt++) {
          if (ctx.shouldStop()) return;
          attempts++;
          const r = await testOne(
            controllerPort,
            secret,
            `w${i}`,
            WARP_SCAN_TEST_URL,
            WARP_SCAN_TIMEOUT_MS
          );
          if (r.latency !== null) {
            latency = r.latency;
            error = null;
            break;
          }
          error = r.error;
        }
        if (ctx.shouldStop()) return;
        ctx.onResult({
          ...candidate,
          status: latency !== null ? 'alive' : 'failed',
          latency,
          error,
          attempts,
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(WARP_SCAN_CONCURRENCY, candidates.length) }, () => worker())
    );
    return { coreOk: true, error: null };
  } catch (e) {
    const error = (e as Error).message;
    for (const c of candidates) {
      ctx.onResult({ ...c, status: 'unknown', latency: null, error, attempts: 0 });
    }
    return { coreOk: false, error };
  } finally {
    if (activeWarpChild === child) activeWarpChild = null;
    try {
      child?.kill('SIGTERM');
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 1500);
    if (home) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

// ===== 测试注入点 =====

export function setWarpScanRunnerForTest(fn: WarpScanRunner | null): void {
  testRunner = fn;
}

export function resetWarpScanStateForTest(): void {
  jobs.clear();
  activeJobId = null;
  testRunner = null;
  stopActiveWarpCore();
}

export async function waitForWarpScanJob(
  id: string,
  timeoutMs = 3000
): Promise<WarpScanJobPublic | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getWarpScanJob(id);
    if (job && job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  return getWarpScanJob(id);
}
