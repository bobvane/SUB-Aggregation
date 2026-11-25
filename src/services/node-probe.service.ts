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

import { createHash } from 'node:crypto';
import { KV_KEYS } from '@/models/config';
import { Node, NodeProtocol, nodeFingerprint as canonicalNodeFingerprint } from '@/models/node';
import {
  runCoreProbe,
  type CoreProbeOutcome,
  CORE_TEST_URLS_KEY,
  DEFAULT_CORE_TEST_URLS,
  CORE_FULL_PROBE_INTERVAL_MS,
} from '@/services/core-probe.service';

const HEALTH_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/**
 * v2.50.0：所有协议统一由 mihomo 核心真实测速（含 Hysteria2/TUIC/WireGuard/AnyTLS/SSR），
 * 不再存在“基础 TCP/TLS 探测不适用”的协议。
 * 保留该函数以兼容既有调用方（返回值恒 true）。
 */
export function isProbeApplicable(_protocol: NodeProtocol): boolean {
  return true;
}

export type ProbeStatus = 'alive' | 'dead' | 'timeout' | 'error' | 'unknown';

export interface ProbeResult {
  nodeId: string;
  fingerprint: string;
  tcpLatency: number | null;
  tlsLatency: number | null;
  /** @deprecated v2.36 起恒为 null：无法在不实现代理协议的情况下测"穿节点 HTTP" */
  httpLatency: number | null;
  status: ProbeStatus;
  /** TLS 是否参与评分（v2.36.x 修复：非 TLS 协议不应因 TLS 维度恒 0 被扣分） */
  tlsApplicable: boolean;
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
  status: ProbeStatus;
  tlsApplicable: boolean;
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
  status: ProbeStatus;
  tlsApplicable: boolean;
  error: string | null;
  score: number;
}

export interface StateMachineResult {
  status: 'active' | 'suspect' | 'disabled';
  reason: string;
}

/**
 * 核心探测结果 → 既有健康记录结构。
 * v2.50.0 起 `tcpLatency` 承载「mihomo 核心 HTTP 延迟」（字段名保留以兼容历史/评分/UI），
 * `tlsLatency` 恒 null，`tlsApplicable` 恒 false（评分自动剔除 TLS 维度）。
 */
function mapCoreOutcome(o: CoreProbeOutcome): ProbeResult {
  return {
    nodeId: o.nodeId,
    fingerprint: o.fingerprint,
    tcpLatency: o.latency,
    tlsLatency: null,
    httpLatency: null,
    status: o.status,
    tlsApplicable: false,
    error: o.error,
    score: 0,
    timestamp: o.timestamp,
  };
}

/**
 * 生成节点指纹 —— 统一委托给 `@/models/node` 的唯一实现（`server:port:protocol` 小写归一）。
 *
 * 规范依据：docs/02_DATA_MODEL.md:78「节点指纹：`server:port:protocol`（小写），
 * 由 `nodeFingerprint()` 生成。禁用/锁定状态按指纹持久化 —— 重抓订阅后不丢失。」
 *
 * 历史缺陷（阶段 C P1 修复）：本文件曾存在一份**未做 toLowerCase 的重复实现**。
 * 由于「探测写入 health:*」与「API/配置层读取」分别使用这两份实现，
 * 当 server 含大写字母时同一节点的三处关联会全部断裂：
 *   ① `health:latest` 键不匹配 → 健康状态 / 评分 / 剔除判定读不到；
 *   ② `locked_nodes` 指纹不匹配 → 人工锁定失效；
 *   ③ `disabled_nodes` 指纹不匹配 → 手动禁用失效。
 * 现统一到规范实现，保留本导出路径以兼容既有导入方（subscription.service 等）。
 */
export const nodeFingerprint = canonicalNodeFingerprint;

/**
 * 四维 Score 计算（阶段 2 / 评分代次 4 起：延迟维度改中位数，稳定性改为样本 CV）
 * Score = 35% 可用率 + 30% 延迟得分 + 25% TLS成功率 + 10% 最近稳定性
 *
 * 窗口：sub_update_interval 小时（resolveWindowHours）
 */
export interface ScoreInput {
  tcpLatency: number | null;
  tlsLatency: number | null;
  tcpOk: boolean;
  tlsOk: boolean;
  /** 协议是否适用 TLS 探测：非 TLS 协议该维度剔除，其余权重按生产表达式重新归一（P0-3） */
  tlsApplicable: boolean;
  /**
   * 窗口内历史记录。
   * `score` 字段**保留以兼容既有历史结构，但评分代次 4 的公式不读取它**
   * ——旧公式用它算「最近稳定性」形成评分自引用；新公式改为在有效延迟样本 S 上算 CV。
   */
  history: Array<{ timestamp: number; tcpLatency: number | null; tlsLatency: number | null; status: string; score: number }>;
  windowHours: number;
  /** 延迟评分归一化基准（毫秒）。默认 1000（旧口径）；生产核心测速传 3000 */
  latencyScaleMs?: number;
  /** 时间基准（显式注入以获得确定性结果）；省略时取 Date.now() */
  now?: number;
}

/**
 * 未来时间戳容差（毫秒）：允许历史记录略微领先当前时间，用于容忍轻微时钟偏差。
 * 超过该范围的记录视为无效历史（按缺失/NaN/非正数同样处理）。
 */
export const FUTURE_TS_TOLERANCE_MS = 5 * 60 * 1000;

/** 核心延迟评分归一化基准（毫秒）：核心 HTTP 延迟通常高于 TCP/TLS RTT，故从 1000ms 放宽到 3000ms */
export const SCORE_LATENCY_SCALE_MS = 3000;

/**
 * 历史记录 timestamp 的**统一**有效性规则（阶段 2 / R1 修复）。
 *
 * 评分侧（calculateScore）与状态机侧（evaluateStateMachine）必须共用本函数，
 * 避免两侧对同一条历史给出不同的有效/无效判断。
 *
 * 排除：
 *  - 字段缺失 / `undefined` / `null`（不做隐式转换）
 *  - 非 number 类型（含数字字符串）
 *  - `NaN` / `Infinity` / `-Infinity`
 *  - `timestamp <= 0`
 *  - 超出容差的未来时间戳（`timestamp > now + FUTURE_TS_TOLERANCE_MS`）
 */
export function isValidHistoryTimestamp(
  h: { timestamp?: unknown },
  now: number
): h is { timestamp: number } {
  const ts = h?.timestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
  if (ts <= 0) return false;
  if (ts > now + FUTURE_TS_TOLERANCE_MS) return false;
  return true;
}

/** 有效延迟判定：必须是有限数值。排除 null / undefined / 缺失字段 / NaN / ±Infinity */
export function isValidLatency(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 延迟口径：TLS RTT 优先，无 TLS 用 TCP RTT，都没有则 null。
 * 阶段 2（评分代次 4）起非有限值不再透传：旧实现用 `??`，NaN 会被当成有效样本
 * 进入中位数 / 均值 / 样本标准差，静默污染评分（且排序行为依赖引擎实现）。
 */
export function nodeLatencyMs(h: { tlsLatency?: number | null; tcpLatency?: number | null }): number | null {
  if (isValidLatency(h.tlsLatency)) return h.tlsLatency;
  if (isValidLatency(h.tcpLatency)) return h.tcpLatency;
  return null;
}

/** 中位数：偶数长度取中间两数平均值。调用方保证数组非空且元素均为有效有限数值 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 四维权重表。非 TLS 协议剔除 TLS 维度后，其余三维按**生产表达式**归一
 * （sum = 0.35+0.30+0.10 = 0.7499999999999999，而不是字面 0.75）。
 * 导出供测试直接验证实际浮点值，避免测试复刻一份可能与生产漂移的表达式。
 */
export function scoreWeights(tlsApplicable: boolean): {
  wAvail: number; wLat: number; wTls: number; wStab: number;
} {
  let wAvail = 0.35, wLat = 0.30, wTls = 0.25, wStab = 0.10;
  if (!tlsApplicable) {
    const sum = wAvail + wLat + wStab;
    wAvail /= sum;
    wLat /= sum;
    wStab /= sum;
    wTls = 0;
  }
  return { wAvail, wLat, wTls, wStab };
}

/**
 * 四维 Score 计算（阶段 2 / 评分代次 4）
 *
 * 口径：
 * - availability：**只统计窗口内有效历史**，分母 N；N=0 → 0.5。本轮探测不计入。
 * - latency：样本 S = 历史 alive 记录的有效延迟 ∪（本轮探测 alive 时的有效延迟）；
 *   |S| < 3 → 0.5；否则 max(0, 1 − median(S)/1000)。
 * - stability：与 latency 同一 S；|S|=0 → 0；1–3 → 0.5；≥4 → 1 − min(CV, 1)，
 *   CV = 样本标准差（分母 n−1）/ 均值；mean===0 → CV 按 0；mean 非有限 → 0.5。
 * - TLS：分母 N+1（历史 + 本轮）；分子仅计 tlsLatency 为有效有限数值的条数
 *   （缺失/undefined/null 一律不算成功）。
 * - 非 TLS：剔除 TLS 维度，其余三维按生产表达式归一（sum = 0.35+0.30+0.10，不得用字面 0.75）。
 * - 时间：仅接受 timestamp 为有限数且 > 0 的记录，再按窗口过滤，最后按 timestamp 降序
 *   ——保证聚合结果与历史输入顺序无关。
 * - Q1 例外（阶段 2 业务规则）：本轮探测失败且窗口内零 alive 证据 → 直接 0。
 */
export function calculateScore(input: ScoreInput): number {
  const { tcpLatency, tlsLatency, tcpOk, tlsOk, tlsApplicable, history, windowHours } = input;
  const latencyScale = input.latencyScaleMs ?? 1000;
  const now = input.now ?? Date.now();
  const windowMs = windowHours * 3600 * 1000;

  // 窗口内有效历史：时间戳有效性统一走 isValidHistoryTimestamp（与状态机侧同一规则），
  // 窗口外记录一并剔除。评分公式、权重与窗口长度均不变。
  const recent = history
    .filter(h => isValidHistoryTimestamp(h, now))
    .filter(h => now - h.timestamp <= windowMs)
    .sort((a, b) => b.timestamp - a.timestamp);
  const N = recent.length;

  // 1. 可用率 (35%)：只统计历史；N=0 取默认基线 0.5
  const aliveCount = recent.filter(h => h.status === 'alive').length;
  const availabilityScore = N === 0 ? 0.5 : aliveCount / N;

  // 本轮是否 alive（核心测速：status==='alive'；tlsApplicable 恒 false，TLS 维度不参与）
  const probeAlive = tcpOk && (tlsApplicable ? tlsOk : true);

  // Q1：本轮探测失败（TCP 不通 / TCP 通但 TLS 握手失败 / 非 TLS 节点 TCP 不通）
  // 且窗口内不存在任何 alive 证据 → 完全无可达证据，直接 0。
  // 只要存在 alive 历史证据，本规则不介入。
  if (!probeAlive && aliveCount === 0) return 0;

  // 2/3. 有效延迟样本 S：历史 alive 记录 ∪ 本轮（仅当本轮 alive）
  const samples: number[] = [];
  for (const h of recent) {
    if (h.status !== 'alive') continue;
    const v = nodeLatencyMs(h);
    if (v !== null) samples.push(v);
  }
  if (probeAlive) {
    const measured = nodeLatencyMs({ tlsLatency, tcpLatency });
    if (measured !== null) samples.push(measured);
  }

  // 延迟得分 (30%)：样本不足 3 条取默认基线 0.5；否则用中位数
  const latencyScore = samples.length < 3 ? 0.5 : Math.max(0, 1 - median(samples) / latencyScale);

  // 稳定性 (10%)：同一 S 上的变异系数
  let stabilityScore: number;
  if (samples.length === 0) {
    stabilityScore = 0;
  } else if (samples.length <= 3) {
    stabilityScore = 0.5;
  } else {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (mean === 0) {
      stabilityScore = 1; // CV 按 0 处理 → 1 − min(0, 1)
    } else if (!Number.isFinite(mean)) {
      stabilityScore = 0.5;
    } else {
      const variance = samples.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (samples.length - 1);
      stabilityScore = 1 - Math.min(Math.sqrt(variance) / mean, 1);
    }
  }

  // 4. TLS成功率 (25%)：分母 N+1（历史 + 本轮）
  const histTlsOk = recent.filter(h => isValidLatency(h.tlsLatency)).length;
  const probeTlsOk = isValidLatency(tlsLatency) ? 1 : 0;
  const tlsScore = (histTlsOk + probeTlsOk) / (N + 1);

  // 非 TLS 协议不参与 TLS 维度，其余权重按生产表达式重新归一
  const { wAvail, wLat, wTls, wStab } = scoreWeights(tlsApplicable);

  const totalScore = Math.round(
    (availabilityScore * wAvail +
     latencyScore * wLat +
     tlsScore * wTls +
     stabilityScore * wStab) * 100
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
/** P0-2：导出供状态机测试直接验证熔断口径（生产路径仍走 doProbeAllNodes 内部调用） */
export function evaluateStateMachine(
  history: Array<{ status: string; timestamp: number }>,
  /** 时间基准（显式注入以获得确定性结果）；省略时取 Date.now()。R1：与评分侧共用同一有效性规则 */
  now: number = Date.now()
): StateMachineResult {
  // 时间戳有效性统一走 isValidHistoryTimestamp（与 calculateScore 同一规则）：
  // 缺失 / undefined / null / 非数字 / NaN / ±Infinity / <=0 / 超容差未来记录一律排除，
  // **不参与连续计数**，也不因排除而把记录改判为 dead/alive。
  const sorted = history
    .filter(h => isValidHistoryTimestamp(h, now))
    .sort((a, b) => b.timestamp - a.timestamp);  // 按时间倒序（最新在前）

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
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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
 * 三个**互相独立**的代次键（阶段 2 起分离，不再混为一个版本号）：
 *
 * - `probe:score_version`  评分公式代次。公式口径变更时 +1。**变更不得删除任何历史数据**。
 * - `probe:schema_version` 历史记录结构代次。仅当 health:hist / health:latest 的**字段结构**
 *                          真正不兼容时才 +1；届时才允许执行明确、可验证的数据迁移。
 * - `probe:engine_version` 探测方式代次（保留原键名与调用路径，兼容既有运维与测试）。
 *
 * 历史教训：旧实现把三者混为一个数字，版本不一致时**无差别删除** health:hist:* 与
 * health:latest:*。该行为有真实可用性风险：getDroppedNodes() 只读 health:latest，
 * 清空即让 statusMachine='disabled' 的节点立刻重新进入生成的 Mihomo 配置
 * （需再连续失败 3 轮才会被重新剔除），同时把状态机的连续失败计数一并归零。
 * 故阶段 2 起改为「只写版本号、不动数据」。
 */
const PROBE_ENGINE_VERSION = 5;
const PROBE_SCORE_VERSION = 5;
const PROBE_SCHEMA_VERSION = 1;
const PROBE_ENGINE_KEY = 'probe:engine_version';
const PROBE_SCORE_KEY = 'probe:score_version';
const PROBE_SCHEMA_KEY = 'probe:schema_version';

/** 代次键名（供测试与诊断读取，避免测试硬编码字符串） */
export const PROBE_VERSION_KEYS = {
  engine: PROBE_ENGINE_KEY,
  score: PROBE_SCORE_KEY,
  schema: PROBE_SCHEMA_KEY,
} as const;

/** 代次键当前值（供测试与诊断读取） */
export const PROBE_VERSION_VALUES = {
  engine: String(PROBE_ENGINE_VERSION),
  score: String(PROBE_SCORE_VERSION),
  schema: String(PROBE_SCHEMA_VERSION),
} as const;

/**
 * 同步三个代次键。函数名沿用历史的 `resetProbeDataIfEngineChanged`，
 * 但自阶段 2 起**不再删除任何健康数据**（名称保留以兼容既有调用路径）。
 *
 * 返回值 = 版本键是否发生变化（任一键缺失或与当前值不同）。
 * 说明：**键缺失不等于历史结构不兼容**。新装环境、旧库首次升级、键被外部清除等
 * 场景一律只补写版本号，不清空 health:hist:* / health:latest:*。
 * `probe:schema_version` 未发生结构代次变更时，此处不执行任何迁移。
 */
export async function resetProbeDataIfEngineChanged(storage: HealthStorage): Promise<boolean> {
  const [engine, score, schema] = await Promise.all([
    storage.get(PROBE_ENGINE_KEY),
    storage.get(PROBE_SCORE_KEY),
    storage.get(PROBE_SCHEMA_KEY),
  ]);

  const changed =
    engine !== String(PROBE_ENGINE_VERSION) ||
    score !== String(PROBE_SCORE_VERSION) ||
    schema !== String(PROBE_SCHEMA_VERSION);

  await storage.put(PROBE_ENGINE_KEY, String(PROBE_ENGINE_VERSION));
  await storage.put(PROBE_SCORE_KEY, String(PROBE_SCORE_VERSION));
  await storage.put(PROBE_SCHEMA_KEY, String(PROBE_SCHEMA_VERSION));
  return changed;
}

/**
 * 并发门闩：串行化全量探测，避免「手动测活」与「订阅更新/自动更新」同时触发时，
 * 同一网络状况被写进多个历史记录 → 连续失败计数被同一事实重复累计成多轮。
 * 第二个调用方等待当前轮完成后再作为独立的新一轮执行。
 */
export interface ProbeAllStats {
  total: number;
  alive: number;
  dead: number;
  unknown: number;
  suspect: number;
  disabled: number;
  avgLatency: number | null;
  minLatency: number | null;
}
export interface ProbeAllResult {
  results: ProbeResult[];
  stats: ProbeAllStats;
}

export interface ProbeAllOptions {
  /** true = 全量测速（手动按钮）；false/省略 = 增量（仅新增/变化节点，每 6 小时自动全量） */
  full?: boolean;
}

let probeAllNodesInflight: Promise<ProbeAllResult> | null = null;

export function probeAllNodes(
  nodes: Node[],
  storage: HealthStorage,
  windowHours?: number,
  opts?: ProbeAllOptions
): Promise<ProbeAllResult> {
  if (probeAllNodesInflight) {
    return probeAllNodesInflight.then(() => doProbeAllNodes(nodes, storage, windowHours, opts));
  }
  probeAllNodesInflight = doProbeAllNodes(nodes, storage, windowHours, opts).finally(() => {
    probeAllNodesInflight = null;
  });
  return probeAllNodesInflight;
}

/** 节点连通性相关字段的稳定哈希（增量测速判断节点是否变化） */
function nodeConnectivityHash(node: Node): string {
  const relevant = {
    server: node.server,
    port: node.port,
    protocol: node.protocol,
    username: node.username,
    password: node.password,
    uuid: node.uuid,
    tls: node.tls,
    transport: node.transport,
    flow: node.flow,
    pbk: node.pbk,
    sid: node.sid,
    sni: node.sni,
    plugin: node.plugin,
    allowInsecure: node.allowInsecure,
    ports: node.ports,
    up: node.up,
    down: node.down,
    obfs: node.obfs,
    obfsPassword: node.obfsPassword,
    token: node.token,
    udpRelayMode: node.udpRelayMode,
    congestionController: node.congestionController,
    disableSni: node.disableSni,
    reduceRtt: node.reduceRtt,
    fastOpen: node.fastOpen,
    wgIp: node.wgIp,
    wgIpv6: node.wgIpv6,
    wgPrivateKey: node.wgPrivateKey,
    wgPublicKey: node.wgPublicKey,
    wgAllowedIps: node.wgAllowedIps,
    wgPreSharedKey: node.wgPreSharedKey,
    wgReserved: node.wgReserved,
    wgMtu: node.wgMtu,
    idleSessionCheckInterval: node.idleSessionCheckInterval,
    idleSessionTimeout: node.idleSessionTimeout,
    minIdleSession: node.minIdleSession,
    clientMetadata: node.clientMetadata,
    ssrProtocol: node.ssrProtocol,
    ssrProtocolParam: node.ssrProtocolParam,
    ssrObfsParam: node.ssrObfsParam,
    alpn: node.alpn,
    fingerprint: node.fingerprint,
  };
  return createHash('sha1').update(JSON.stringify(relevant)).digest('hex');
}

const PROBE_LAST_FULL_KEY = 'probe:last_full_at';
const PROBE_TESTED_HASHES_KEY = 'probe:tested_hashes';

async function readJsonObject(storage: HealthStorage, key: string): Promise<Record<string, string>> {
  try {
    const raw = await storage.get(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** 选择本轮要测的节点：全量 or 仅新增/变化 */
async function selectNodesToProbe(
  nodes: Node[],
  storage: HealthStorage,
  forceFull?: boolean
): Promise<{ nodes: Node[]; full: boolean }> {
  const now = Date.now();
  let lastFull = 0;
  try {
    lastFull = Number((await storage.get(PROBE_LAST_FULL_KEY)) ?? 0) || 0;
  } catch {
    lastFull = 0;
  }
  const full = !!forceFull || lastFull <= 0 || now - lastFull >= CORE_FULL_PROBE_INTERVAL_MS;
  if (full) return { nodes, full: true };
  const tested = await readJsonObject(storage, PROBE_TESTED_HASHES_KEY);
  const selected = nodes.filter((n) => tested[nodeFingerprint(n)] !== nodeConnectivityHash(n));
  return { nodes: selected, full: false };
}

/** 更新增量测速元数据（只记录本轮实际测过的节点） */
async function updateProbeMemo(
  storage: HealthStorage,
  allNodes: Node[],
  testedNodes: Node[],
  full: boolean
): Promise<void> {
  try {
    if (full) {
      const hashes: Record<string, string> = {};
      for (const n of allNodes) hashes[nodeFingerprint(n)] = nodeConnectivityHash(n);
      await storage.put(PROBE_TESTED_HASHES_KEY, JSON.stringify(hashes));
      await storage.put(PROBE_LAST_FULL_KEY, String(Date.now()));
    } else {
      const hashes = await readJsonObject(storage, PROBE_TESTED_HASHES_KEY);
      for (const n of testedNodes) hashes[nodeFingerprint(n)] = nodeConnectivityHash(n);
      await storage.put(PROBE_TESTED_HASHES_KEY, JSON.stringify(hashes));
    }
  } catch {
    // 增量元数据写入失败不影响本轮结果
  }
}

/** 读取设置里的测试 URL 列表 */
async function readCoreTestUrls(storage: HealthStorage): Promise<string[]> {
  try {
    const raw = await storage.get(KV_KEYS.setting(CORE_TEST_URLS_KEY));
    if (!raw) return DEFAULT_CORE_TEST_URLS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_CORE_TEST_URLS;
    const urls = parsed.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
    return urls.length > 0 ? urls : DEFAULT_CORE_TEST_URLS;
  } catch {
    return DEFAULT_CORE_TEST_URLS;
  }
}

/**
 * 全量/增量探测所有节点（mihomo 核心真实测速）
 * windowHours 省略时自动取设置页 sub_update_interval（刷新一次测一次，窗口跟着走）
 */
async function doProbeAllNodes(
  nodes: Node[],
  storage: HealthStorage,
  windowHours?: number,
  opts?: ProbeAllOptions
): Promise<ProbeAllResult> {
  const win = windowHours ?? (await resolveWindowHours(storage));
  await resetProbeDataIfEngineChanged(storage);

  // 增量：只测新增/变化节点；每 6 小时或手动触发时全量。
  const { nodes: testNodes, full } = await selectNodesToProbe(nodes, storage, opts?.full);
  const results: ProbeResult[] = [];

  if (testNodes.length > 0) {
    const core = await runCoreProbe(testNodes, { testUrls: await readCoreTestUrls(storage) });
    results.push(...core.outcomes.map(mapCoreOutcome));
    if (!core.coreOk && core.error) {
      console.warn(`[Probe] 核心测速未完全成功: ${core.error}`);
    }
  }

  // 写入历史 + 计算评分 + 状态机 + 写最新快照
  const machineStatus = new Map<string, 'active' | 'suspect' | 'disabled'>();
  for (const result of results) {
    // 核心不可用/单批失败：标记 unknown，不写历史、不写快照、不参与状态机（保留旧健康数据）。
    if (result.status === 'unknown') {
      continue;
    }

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

    // 计算评分（核心延迟写入 tcpLatency；tlsApplicable=false 时自动剔除 TLS 维度）
    const historyForScore = history.map(h => ({
      timestamp: h.timestamp,
      tcpLatency: h.tcpLatency,
      tlsLatency: h.tlsLatency,
      status: h.status,
      score: h.score,
    }));

    // 本轮时间基准：评分与状态机共用同一 `now`
    const nowTs = Date.now();

    result.score = calculateScore({
      tcpLatency: result.tcpLatency,
      tlsLatency: result.tlsLatency,
      tcpOk: result.status === 'alive',
      tlsOk: false,
      tlsApplicable: false,
      history: historyForScore,
      windowHours: win,
      latencyScaleMs: SCORE_LATENCY_SCALE_MS,
      now: nowTs,
    });

    // 状态机判定（把本轮结果计入历史再评估）
    const machineHistory = [...history, { status: result.status, timestamp: result.timestamp }];
    const stateMachine = evaluateStateMachine(machineHistory, nowTs);
    machineStatus.set(result.fingerprint, stateMachine.status);

    // 写历史（追加），同一毫秒冲突顺延 1ms
    let historyTs = result.timestamp;
    let historyKey = KV_KEYS.healthHistory(result.fingerprint, historyTs);
    if (await storage.get(historyKey)) {
      historyTs += 1;
      historyKey = KV_KEYS.healthHistory(result.fingerprint, historyTs);
    }
    await storage.put(
      historyKey,
      JSON.stringify({ ...result, timestamp: historyTs, statusMachine: stateMachine.status }),
      { expirationTtl: HEALTH_HISTORY_TTL_MS / 1000 }
    );

    // 写最新快照（覆盖）
    await storage.put(
      KV_KEYS.healthLatest(result.fingerprint),
      JSON.stringify({ ...result, statusMachine: stateMachine.status })
    );
  }

  // 更新增量测速元数据（只记录本轮实际测过的节点）
  await updateProbeMemo(storage, nodes, testNodes, full);

  // 清理 30 天前历史
  await cleanupOldHistory(storage, results.filter(r => r.status !== 'unknown').map(r => r.fingerprint));

  // 统计（供前端测活结果反馈用）—— dead 只统计显式 dead，不含 unknown
  const alive = results.filter(r => r.status === 'alive').length;
  const dead = results.filter(r => r.status === 'dead').length;
  const unknown = results.filter(r => r.status === 'unknown').length;
  const mss = [...machineStatus.values()];
  const latencies = results.map(r => nodeLatencyMs(r)).filter((v): v is number => v !== null);

  // v2.36.3: 测活完成统一落操作日志（手动/订阅刷新/自动更新 4 个入口共用此处，一处全覆盖）
  try {
    const { createOperationLog } = await import('@/services/operation-log.service');
    await createOperationLog(storage).logProbe(
      results.length, alive, dead, mss.filter(s => s === 'disabled').length
    );
  } catch (e) {
    console.warn(`[Probe] 操作日志写入失败(不影响测活): ${(e as Error).message}`);
  }

  return {
    results,
    stats: {
      total: results.length,
      alive,
      dead,
      unknown,
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
