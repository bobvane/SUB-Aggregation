/**
 * v2.32: 节点探测引擎 + 五维评分 + 状态机
 * v2.36: 探测改为真实握手（node:net / node:tls）
 *
 * 拓扑：
 * Subscription → Parser → Node Pool → Health Engine
 *                                           ↓
 *                               ┌──────────┴──────────┐
 *                               ↓                     ↓
 *                          TCP Connect           TLS Handshake（仅 tls 节点）
 *                               ↓                     ↓
 *                          Latency / Reachability
 *                               ↓
 *                          评分（可用率/延迟/TLS/稳定性）
 *                               ↓
 *                          状态机熔断
 *
 * 存储：KV 抽象（health:hist:{fingerprint}:{ts} / health:latest:{fingerprint}）
 *
 * 说明：不再测「HTTP 204 穿节点」。穿透必须实现 VLESS/VMess 客户端，本机 fetch
 * Google 测的是服务器自己而非节点（旧实现如此，已删）。可达性由 TCP/TLS 握手判定，
 * 延迟取 TLS RTT（有）否则 TCP RTT。
 */

import net from 'node:net';
import tls from 'node:tls';
import { KV_KEYS } from '@/models/config';
import { Node } from '@/models/node';
import { KVStorage } from '@/storage/kv';

const PROBE_TIMEOUT_MS = 3000;
const PROBE_CONCURRENCY = 50;
const HEALTH_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface ProbeResult {
  nodeId: string;
  fingerprint: string;
  tcpLatency: number | null;
  tlsLatency: number | null;
  /** @deprecated v2.36 起恒为 null：无法在不实现代理协议的情况下测"穿节点 HTTP" */
  httpLatency: number | null;
  status: 'alive' | 'dead' | 'timeout' | 'error';
  error: string | null;
  score: number;
  timestamp: number;
}

export interface NodeHealthLatest {
  nodeId: string;
  fingerprint: string;
  timestamp: number;
  tcpLatency: number | null;
  tlsLatency: number | null;
  /** @deprecated v2.36 起恒为 null */
  httpLatency: number | null;
  status: 'alive' | 'dead' | 'timeout' | 'error';
  error: string | null;
  score: number;
  statusMachine?: 'active' | 'suspect' | 'disabled';
}

export interface NodeHealthHistory {
  nodeId: string;
  fingerprint: string;
  timestamp: number;
  tcpLatency: number | null;
  tlsLatency: number | null;
  /** @deprecated v2.36 起恒为 null */
  httpLatency: number | null;
  status: 'alive' | 'dead' | 'timeout' | 'error';
  error: string | null;
  score: number;
}

export interface ScoreBreakdown {
  availability: number;    // 30% - 可用率
  latency: number;         // 25% - 延迟得分
  tlsSuccess: number;      // 20% - TLS成功率
  httpSuccess: number;     // 15% - HTTP成功率
  stability: number;       // 10% - 最近稳定性（均值）
  total: number;
}

export interface StateMachineResult {
  status: 'active' | 'suspect' | 'disabled';
  reason: string;
}

/**
 * TCP Connect 探测 —— 真实 TCP 三次握手 RTT
 * 节点端口不是 WebSocket 服务，不能拿 wss:// 当连通性测试（v2.35 及以前如此，全部误判为 dead）
 */
function probeTcp(host: string, port: number): Promise<{ latency: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host, port });
    const done = (r: { latency: number | null; error: string | null }) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => done({ latency: Date.now() - start, error: null }));
    sock.once('timeout', () => done({ latency: null, error: 'TCP 超时' }));
    sock.once('error', (e: NodeJS.ErrnoException) => done({ latency: null, error: `TCP ${e.code ?? e.message}` }));
  });
}

/**
 * TLS 握手探测 —— 真实 handshake RTT
 * 只量握手耗时，不校验证书链（自签/过期证书不影响节点可用性判断）
 */
function probeTls(host: string, port: number): Promise<{ latency: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let sock: tls.TLSSocket;
    try {
      // 裸 IP 节点不能设 servername（Node 直接抛错），只有域名才带 SNI
      const opts: tls.ConnectionOptions = {
        host,
        port,
        rejectUnauthorized: false,
        ...(net.isIP(host) === 0 ? { servername: host } : {}),
      };
      sock = tls.connect(opts);
    } catch (e) {
      resolve({ latency: null, error: `TLS ${(e as Error).message}` });
      return;
    }
    const done = (r: { latency: number | null; error: string | null }) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('secureConnect', () => done({ latency: Date.now() - start, error: null }));
    sock.once('timeout', () => done({ latency: null, error: 'TLS 超时' }));
    sock.once('error', (e: NodeJS.ErrnoException) => done({ latency: null, error: `TLS ${e.code ?? e.message}` }));
  });
}

/**
 * 单节点三段串行探测
 */
/**
 * 单节点探测：TCP 握手 →（tls 节点才做）TLS 握手
 * 判定：TCP 不通 = dead；tls 节点 TLS 握手不过 = dead。
 * 延迟取 TLS RTT，无 TLS 时取 TCP RTT。
 */
async function probeNode(node: Node): Promise<ProbeResult> {
  const fingerprint = nodeFingerprint(node);
  const timestamp = Date.now();
  const httpLatency: number | null = null; // 穿节点 HTTP 不可测，恒 null（见文件头说明）

  const tcp = await probeTcp(node.server, node.port);
  if (tcp.latency === null) {
    return {
      nodeId: node.id, fingerprint, tcpLatency: null, tlsLatency: null, httpLatency,
      status: 'dead', error: tcp.error, score: 0, timestamp,
    };
  }

  // 明文协议（ss / 无 tls 的 vmess 等）不做 TLS 握手：必然失败，不代表节点坏
  if (node.tls) {
    const handshake = await probeTls(node.server, node.port);
    if (handshake.latency === null) {
      return {
        nodeId: node.id, fingerprint, tcpLatency: tcp.latency, tlsLatency: null, httpLatency,
        status: 'dead', error: handshake.error, score: 0, timestamp,
      };
    }
    return {
      nodeId: node.id, fingerprint, tcpLatency: tcp.latency, tlsLatency: handshake.latency, httpLatency,
      status: 'alive', error: null,
      score: calculateScore({
        tcpLatency: tcp.latency, tlsLatency: handshake.latency,
        tcpOk: true, tlsOk: true, history: [], windowHours: 24,
      }),
      timestamp,
    };
  }

  return {
    nodeId: node.id, fingerprint, tcpLatency: tcp.latency, tlsLatency: null, httpLatency,
    status: 'alive', error: null,
    score: calculateScore({
      tcpLatency: tcp.latency, tlsLatency: null,
      tcpOk: true, tlsOk: true, history: [], windowHours: 24,
    }),
    timestamp,
  };
}

/**
 * 生成节点指纹
 */
export function nodeFingerprint(node: Node): string {
  return `${node.server}:${node.port}:${node.protocol}`;
}

/**
 * 四维 Score 计算（v2.36：删除测不到的 HTTP 维度，权重重新归一）
 * Score = 35% 可用率 + 30% 延迟得分 + 25% TLS成功率 + 10% 最近稳定性
 *
 * 冷启动：历史不足 3 条时各维度 50% 起始分
 * 窗口：sub_update_interval 小时
 */
interface ScoreInput {
  tcpLatency: number | null;
  tlsLatency: number | null;
  tcpOk: boolean;
  tlsOk: boolean;
  history: Array<{ timestamp: number; tcpLatency: number | null; tlsLatency: number | null; status: string; score: number }>;
  windowHours: number;
}

/** 延迟口径：TLS RTT 优先，无 TLS 用 TCP RTT，都没有则 null */
export function nodeLatencyMs(h: { tlsLatency: number | null; tcpLatency: number | null }): number | null {
  return h.tlsLatency ?? h.tcpLatency ?? null;
}

function calculateScore(input: ScoreInput): number {
  const { tcpLatency, tlsLatency, history, windowHours } = input;
  const now = Date.now();
  const windowMs = windowHours * 3600 * 1000;

  // 窗口内的历史记录
  const recent = history.filter(h => now - h.timestamp <= windowMs);
  const total = recent.length || 1; // 避免除零

  // 1. 可用率 (35%) - 窗口内 alive 次数 / 总次数
  const aliveCount = recent.filter(h => h.status === 'alive').length;
  const availability = aliveCount / total;

  // 2. 延迟得分 (30%) - 1 - 延迟/1000，封顶 1.0
  const measured = nodeLatencyMs({ tlsLatency, tcpLatency });
  const past = recent.map(h => nodeLatencyMs(h)).filter((v): v is number => v !== null);
  const minLatency = measured !== null ? Math.min(measured, ...(past.length ? past : [measured])) : (past.length ? Math.min(...past) : 1000);
  const latencyScore = Math.max(0, 1 - minLatency / 1000);

  // 3. TLS成功率 (25%) - 窗口内 TLS 握手成功次数 / 总次数
  const tlsOkCount = recent.filter(h => h.tlsLatency !== null).length;
  const tlsSuccess = tlsOkCount / total;

  // 4. 最近稳定性 (10%) - 近 5 次 score 均值（score 是 0-100，必须归一）
  const recentScores = recent.slice(-5).map(h => h.score);
  const stability = recentScores.length ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length / 100 : 0.5;

  // 冷启动：历史不足时各维度 50%
  const hasHistory = recent.length >= 3;
  const base = hasHistory ? 0 : 0.5;

  const finalAvailability = hasHistory ? availability : base;
  const finalLatency = hasHistory ? latencyScore : base;
  const finalTls = hasHistory ? tlsSuccess : base;
  const finalStability = hasHistory ? stability : base;

  const totalScore = Math.round(
    (finalAvailability * 0.35 +
     finalLatency * 0.30 +
     finalTls * 0.25 +
     finalStability * 0.10) * 100
  );

  return Math.max(0, Math.min(100, totalScore));
}

/**
 * 状态机熔断
 * 连续失败 1 次 → suspect
 * 连续失败 3 次 → disabled
 * 连续成功 2 次 → active
 * 节点永不物理删除
 */
function evaluateStateMachine(history: Array<{ status: string; timestamp: number }>): StateMachineResult {
  // 按时间倒序排列（最新在前）
  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  
  let consecutiveFail = 0;
  let consecutiveSuccess = 0;
  
  for (const h of sorted) {
    if (h.status === 'alive') {
      consecutiveSuccess++;
      if (consecutiveFail > 0) break; // 连续被打断
    } else {
      consecutiveFail++;
      if (consecutiveSuccess > 0) break;
    }
  }
  
  if (consecutiveFail >= 3) {
    return { status: 'disabled', reason: `连续失败 ${consecutiveFail} 次` };
  }
  if (consecutiveFail >= 1) {
    return { status: 'suspect', reason: `连续失败 ${consecutiveFail} 次` };
  }
  if (consecutiveSuccess >= 2) {
    return { status: 'active', reason: `连续成功 ${consecutiveSuccess} 次` };
  }
  
  // 默认保持当前状态（没有足够证据改变）
  const latest = sorted[0];
  if (!latest) return { status: 'active', reason: '无历史数据，默认 active' };
  
  return { status: latest.status === 'alive' ? 'active' : 'suspect', reason: '默认状态' };
}

/**
 * KV 存储接口（复用 KVStorage 抽象）
 */
export interface HealthStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string }[]>;
}

/**
 * 统计窗口 = 设置页「链接更新时间」sub_update_interval（小时 1-24）。
 * 0=不自动更新 → 回退 24；缺失/非法同样回退 24。
 */
export async function resolveWindowHours(storage: HealthStorage): Promise<number> {
  try {
    const h = Number.parseInt((await storage.get(KV_KEYS.setting('sub_update_interval'))) ?? '', 10);
    return Number.isFinite(h) && h >= 1 && h <= 24 ? h : 24;
  } catch {
    return 24;
  }
}

/**
 * 全量探测所有节点
 * windowHours 省略时自动取设置页 sub_update_interval（刷新一次测一次，窗口跟着走）
 */
export async function probeAllNodes(
  nodes: Node[],
  storage: HealthStorage,
  windowHours?: number
): Promise<{
  results: ProbeResult[];
  stats: {
    total: number;
    alive: number;
    dead: number;
    suspect: number;
    disabled: number;
    avgLatency: number | null;
    minLatency: number | null;
  };
}> {
  const win = windowHours ?? (await resolveWindowHours(storage));
  const results: ProbeResult[] = [];
  
  // 并发控制：分批 Promise.all
  for (let i = 0; i < nodes.length; i += PROBE_CONCURRENCY) {
    const batch = nodes.slice(i, i + PROBE_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(node => probeNode(node)));
    results.push(...batchResults);
  }
  
  // 写入历史 + 计算评分 + 状态机 + 写最新快照
  const machineStatus = new Map<string, 'active' | 'suspect' | 'disabled'>();
  for (const result of results) {
    // 读取历史用于评分和状态机
    const historyKeys = await storage.list(`${KV_KEYS.healthHistory(result.fingerprint, 0).split(':').slice(0, -1).join(':')}:`);
    const history: NodeHealthHistory[] = [];
    
    for (const k of historyKeys) {
      const raw = await storage.get(k.key);
      if (raw) {
        try {
          history.push(JSON.parse(raw));
        } catch {}
      }
    }
    
    // 计算四维评分
    const historyForScore = history.map(h => ({
      timestamp: h.timestamp,
      tcpLatency: h.tcpLatency,
      tlsLatency: h.tlsLatency,
      status: h.status,
      score: h.score,
    }));
    
    result.score = calculateScore({
      tcpLatency: result.tcpLatency,
      tlsLatency: result.tlsLatency,
      tcpOk: result.tcpLatency !== null,
      tlsOk: result.tlsLatency !== null,
      history: historyForScore,
      windowHours: win,
    });
    
    // 状态机判定
    const stateMachine = evaluateStateMachine(history.map(h => ({ status: h.status, timestamp: h.timestamp })));
    machineStatus.set(result.fingerprint, stateMachine.status);
    
    // 写历史（追加）
    await storage.put(
      KV_KEYS.healthHistory(result.fingerprint, result.timestamp),
      JSON.stringify({ ...result, statusMachine: stateMachine.status })
    );
    
    // 写最新快照（覆盖）
    await storage.put(
      KV_KEYS.healthLatest(result.fingerprint),
      JSON.stringify({ ...result, statusMachine: stateMachine.status })
    );
  }
  
  // 清理 30 天前历史
  await cleanupOldHistory(storage, results.map(r => r.fingerprint));
  
  // 统计（供前端测活结果反馈用）
  const alive = results.filter(r => r.status === 'alive').length;
  const dead = results.length - alive;
  const mss = [...machineStatus.values()];
  const latencies = results.map(r => nodeLatencyMs(r)).filter((v): v is number => v !== null);

  return {
    results,
    stats: {
      total: results.length,
      alive,
      dead,
      suspect: mss.filter(s => s === 'suspect').length,
      disabled: mss.filter(s => s === 'disabled').length,
      avgLatency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      minLatency: latencies.length ? Math.min(...latencies) : null,
    },
  };
}

/**
 * 清理 30 天前的健康历史
 */
async function cleanupOldHistory(storage: HealthStorage, fingerprints: string[]): Promise<void> {
  const cutoff = Date.now() - HEALTH_HISTORY_TTL_MS;
  
  for (const fp of fingerprints) {
    const keys = await storage.list(`${KV_KEYS.healthHistory(fp, 0).split(':').slice(0, -1).join(':')}:`);
    
    for (const k of keys) {
      // key 格式: health:hist:{fingerprint}:{timestamp}
      const tsStr = k.key.split(':').pop();
      const ts = Number(tsStr);
      if (ts && ts < cutoff) {
        await storage.delete(k.key);
      }
    }
  }
}

/**
 * 获取节点最新健康快照
 */
export async function getNodeHealthLatest(
  fingerprint: string,
  storage: HealthStorage
): Promise<NodeHealthLatest | null> {
  const raw = await storage.get(KV_KEYS.healthLatest(fingerprint));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 获取节点健康历史（用于趋势图）
 */
export async function getNodeHealthHistory(
  fingerprint: string,
  storage: HealthStorage,
  limit: number = 100
): Promise<NodeHealthHistory[]> {
  const keys = await storage.list(`${KV_KEYS.healthHistory(fingerprint, 0).split(':').slice(0, -1).join(':')}:`);
  const history: NodeHealthHistory[] = [];
  
  // 按时间倒序
  const sortedKeys = keys.sort((a, b) => b.key.localeCompare(a.key)).slice(0, limit);
  
  for (const k of sortedKeys) {
    const raw = await storage.get(k.key);
    if (raw) {
      try {
        history.push(JSON.parse(raw));
      } catch {}
    }
  }
  
  return history;
}

/** 获取所有节点的最新健康快照 */
export async function getAllNodeHealth(
  storage: HealthStorage
): Promise<NodeHealthLatest[]> {
  const health: NodeHealthLatest[] = [];
  const keys = await storage.list('health:latest:');
  
  for (const k of keys) {
    const raw = await storage.get(k.key);
    if (raw) {
      try {
        const entry = JSON.parse(raw);
        health.push(entry);
      } catch {}
    }
  }
  
  return health;
}

/** 便捷导出：供 routes 直接调用 */
export async function getNodeHealth(
  fingerprint: string,
  kv: KVStorage
): Promise<NodeHealthLatest | null> {
  return getNodeHealthLatest(fingerprint, kv);
}

export async function getNodeHistory(
  fingerprint: string,
  kv: KVStorage,
  limit: number = 100
): Promise<NodeHealthHistory[]> {
  return getNodeHealthHistory(fingerprint, kv, limit);
}