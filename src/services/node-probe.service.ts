/**
 * v2.32: 节点探测引擎 + 五维评分 + 状态机
 * 
 * 拓扑：
 * Subscription → Parser → Node Pool → Health Engine
 *                                           ↓
 *                               ┌──────────┴──────────┐
 *                               ↓                     ↓
 *                          TCP Test              TLS Test
 *                               ↓                     ↓
 *                          HTTP Test (Google 204)
 *                               ↓
 *                          Latency / Handshake / Availability
 *                               ↓
 *                          五维 Score
 *                               ↓
 *                          状态机熔断
 * 
 * 存储：KV 抽象（health:hist:{fingerprint}:{ts} / health:latest:{fingerprint}）
 */

import { KV_KEYS } from '@/models/config';
import { Node } from '@/models/node';
import { KVStorage } from '@/storage/kv';

const PROBE_TIMEOUT_MS = 3000;
const PROBE_CONCURRENCY = 50;
const TEST_URL = 'https://www.google.com/generate_204';
const HEALTH_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface ProbeResult {
  nodeId: string;
  fingerprint: string;
  tcpLatency: number | null;
  tlsLatency: number | null;
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
  httpLatency: number | null;
  status: 'alive' | 'dead' | 'timeout' | 'error';
  error: string | null;
  score: number;
}

export interface NodeHealthHistory {
  nodeId: string;
  fingerprint: string;
  timestamp: number;
  tcpLatency: number | null;
  tlsLatency: number | null;
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
 * TCP Connect 探测
 */
async function probeTcp(host: string, port: number): Promise<{ latency: number | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  
  try {
    // 使用 fetch 的 CONNECT 模拟 TCP 连接（简化：用 HTTP HEAD 代替，实际应用需原生 socket）
    // 这里用简单的 TCP 连接模拟：创建 socket 连接
    const socket = new WebSocket(`wss://${host}:${port}`);
    
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => { socket.close(); resolve(); };
      socket.onerror = () => reject(new Error('TCP connection failed'));
      socket.onclose = () => { if (socket.readyState === WebSocket.CLOSED) resolve(); };
    });
    
    clearTimeout(timeout);
    return { latency: Date.now() - start, error: null };
  } catch (e) {
    clearTimeout(timeout);
    return { latency: null, error: (e as Error).message };
  }
}

/**
 * TLS Handshake 探测
 */
async function probeTls(host: string, port: number): Promise<{ latency: number | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  
  try {
    // TLS 握手:尝试建立 HTTPS 连接
    await fetch(`https://${host}:${port}`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Sub-Aggregation-Probe/1.0' },
    });
    
    clearTimeout(timeout);
    return { latency: Date.now() - start, error: null };
  } catch (e) {
    clearTimeout(timeout);
    return { latency: null, error: (e as Error).message };
  }
}

/**
 * HTTP 204 探测（测速目标：Google 204）
 */
async function probeHttp(): Promise<{ latency: number | null; error: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  
  try {
    const res = await fetch(TEST_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Sub-Aggregation-Probe/1.0' },
    });
    
    clearTimeout(timeout);
    
    if (res.status === 204) {
      return { latency: Date.now() - start, error: null };
    }
    return { latency: null, error: `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(timeout);
    return { latency: null, error: (e as Error).message };
  }
}

/**
 * 单节点三段串行探测
 */
async function probeNode(node: Node): Promise<ProbeResult> {
  const fingerprint = nodeFingerprint(node);
  const timestamp = Date.now();
  
  let tcpLatency: number | null = null;
  let tlsLatency: number | null = null;
  let httpLatency: number | null = null;
  let status: 'alive' | 'dead' | 'timeout' | 'error' = 'dead';
  let error: string | null = null;
  
  // 1. TCP Connect
  const tcp = await probeTcp(node.server, node.port);
  tcpLatency = tcp.latency;
  if (!tcpLatency) {
    error = tcp.error ?? 'TCP timeout';
    return { nodeId: node.id, fingerprint, tcpLatency, tlsLatency, httpLatency, status, error, score: 0, timestamp };
  }
  
  // 2. TLS Handshake
  const tls = await probeTls(node.server, node.port);
  tlsLatency = tls.latency;
  if (!tlsLatency) {
    error = tls.error ?? 'TLS timeout';
    status = 'timeout';
    return { nodeId: node.id, fingerprint, tcpLatency, tlsLatency, httpLatency, status, error, score: 0, timestamp };
  }
  
  // 3. HTTP 204
  const http = await probeHttp();
  httpLatency = http.latency;
  if (!httpLatency) {
    error = http.error ?? 'HTTP timeout';
    status = 'timeout';
    return { nodeId: node.id, fingerprint, tcpLatency, tlsLatency, httpLatency, status, error, score: 0, timestamp };
  }
  
  status = 'alive';
  
  // 评分（简化版，后续用历史数据计算五维）
  const score = calculateScore({
    tcpLatency,
    tlsLatency,
    httpLatency,
    tcpOk: true,
    tlsOk: true,
    httpOk: true,
    history: [],
    windowHours: 24,
  });
  
  return { nodeId: node.id, fingerprint, tcpLatency, tlsLatency, httpLatency, status, error, score, timestamp };
}

/**
 * 生成节点指纹
 */
export function nodeFingerprint(node: Node): string {
  return `${node.server}:${node.port}:${node.protocol}`;
}

/**
 * 五维 Score 计算
 * Score = 30% 可用率 + 25% 延迟得分 + 20% TLS成功率 + 15% HTTP成功率 + 10% 最近稳定性（均值）
 * 
 * 冷启动：各维度 50% 起始分
 * 窗口：sub_update_interval 小时
 */
interface ScoreInput {
  tcpLatency: number | null;
  tlsLatency: number | null;
  httpLatency: number | null;
  tcpOk: boolean;
  tlsOk: boolean;
  httpOk: boolean;
  history: Array<{ timestamp: number; tcpLatency: number | null; tlsLatency: number | null; httpLatency: number | null; status: string; score: number }>;
  windowHours: number;
}

function calculateScore(input: ScoreInput): number {
  const { httpLatency, history, windowHours } = input;
  const now = Date.now();
  const windowMs = windowHours * 3600 * 1000;
  
  // 窗口内的历史记录
  const recent = history.filter(h => now - h.timestamp <= windowMs);
  const total = recent.length || 1; // 避免除零
  
  // 1. 可用率 (30%) - 窗口内 alive 次数 / 总次数
  const aliveCount = recent.filter(h => h.status === 'alive').length;
  const availability = aliveCount / total;
  
  // 2. 延迟得分 (25%) - 1 - min(httpLatency)/1000，封顶 1.0
  // 使用最新 httpLatency，没有则用历史最小值
  const latencies = recent.filter(h => h.httpLatency).map(h => h.httpLatency!);
  const minLatency = httpLatency ? Math.min(httpLatency, ...latencies) : (latencies.length ? Math.min(...latencies) : 1000);
  const latencyScore = Math.max(0, 1 - minLatency / 1000);
  
  // 3. TLS成功率 (20%) - 窗口内 TLS 成功次数 / 总次数
  const tlsOkCount = recent.filter(h => h.tlsLatency !== null).length;
  const tlsSuccess = tlsOkCount / total;
  
  // 4. HTTP成功率 (15%) - 窗口内 HTTP 成功次数 / 总次数
  const httpOkCount = recent.filter(h => h.httpLatency !== null).length;
  const httpSuccess = httpOkCount / total;
  
  // 5. 最近稳定性 (10%) - 近 N 次 score 均值
  // 取最近 5 次或窗口内所有
  const recentScores = recent.slice(-5).map(h => h.score);
  const stability = recentScores.length ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length : 0.5;
  
  // 冷启动：历史不足时各维度 50%
  const hasHistory = recent.length >= 3;
  const base = hasHistory ? 0 : 0.5;
  
  const finalAvailability = hasHistory ? availability : base;
  const finalLatency = hasHistory ? latencyScore : base;
  const finalTls = hasHistory ? tlsSuccess : base;
  const finalHttp = hasHistory ? httpSuccess : base;
  const finalStability = hasHistory ? stability : base;
  
  const totalScore = Math.round(
    (finalAvailability * 0.30 +
     finalLatency * 0.25 +
     finalTls * 0.20 +
     finalHttp * 0.15 +
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
 * 全量探测所有节点
 */
export async function probeAllNodes(
  nodes: Node[],
  storage: HealthStorage,
  windowHours: number = 24
): Promise<{
  results: ProbeResult[];
  stats: { total: number; alive: number; dead: number; suspect: number; disabled: number };
}> {
  const results: ProbeResult[] = [];
  
  // 并发控制：分批 Promise.all
  for (let i = 0; i < nodes.length; i += PROBE_CONCURRENCY) {
    const batch = nodes.slice(i, i + PROBE_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(node => probeNode(node)));
    results.push(...batchResults);
  }
  
  // 写入历史 + 计算评分 + 状态机 + 写最新快照
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
    
    // 计算五维评分
    const historyForScore = history.map(h => ({
      timestamp: h.timestamp,
      tcpLatency: h.tcpLatency,
      tlsLatency: h.tlsLatency,
      httpLatency: h.httpLatency,
      status: h.status,
      score: h.score,
    }));
    
    result.score = calculateScore({
      tcpLatency: result.tcpLatency,
      tlsLatency: result.tlsLatency,
      httpLatency: result.httpLatency,
      tcpOk: result.tcpLatency !== null,
      tlsOk: result.tlsLatency !== null,
      httpOk: result.httpLatency !== null,
      history: historyForScore,
      windowHours,
    });
    
    // 状态机判定
    const stateMachine = evaluateStateMachine(history.map(h => ({ status: h.status, timestamp: h.timestamp })));
    
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
  
  // 统计
  const alive = results.filter(r => r.status === 'alive').length;
  const dead = results.filter(r => r.status !== 'alive').length;
  
  return {
    results,
    stats: { total: results.length, alive, dead, suspect: 0, disabled: 0 },
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