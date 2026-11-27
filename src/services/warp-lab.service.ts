/**
 * WARP 实验页服务（独立模块）
 *
 * 目标：只做「注册 Cloudflare WARP MASQUE 设备 + 生成 MASQUE H2/H3 节点预览」。
 *
 * 隔离约定（重要）：
 *   - 只读写自己的 KV 键 warp_lab:*；
 *   - 不 import config.service / node-probe / models/node；
 *   - 不写入 nodes:*、health:*、settings:*，不参与输出配置、测速、节点列表；
 *   - 删除本文件与相关路由/页面即可完全移除该功能。
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FetchFn } from '@/engine/http-client';

export const WARP_LAB_ACCOUNT_KEY = 'warp_lab:account';
export const WARP_LAB_NODES_KEY = 'warp_lab:nodes';

/** Cloudflare WARP MASQUE 默认 SNI（来自 xehn / usque 的官方客户端常量） */
export const WARP_LAB_DEFAULT_SNI = 'consumer-masque.cloudflareclient.com';

/** 默认端点：MASQUE QUIC 的 .1/.2 与 H2 池里的常见地址 */
export const WARP_LAB_DEFAULT_ENDPOINTS = [
  '162.159.198.1:443',
  '162.159.198.2:443',
  '162.159.199.1:443',
  '162.159.199.2:443',
];

const MASQUE_REG_URL = 'https://api.cloudflareclient.com/v0a4471/reg';
const MASQUE_CLIENT_VERSION = 'a-6.35-4471';
const MASQUE_USER_AGENT = 'WARP for Android';
const MASQUE_MAX_ENDPOINTS = 20;

export interface WarpLabAccount {
  id: string;
  token: string;
  /** base64(DER SEC1 EC private key) */
  privateKey: string;
  /** base64(DER SPKI peer public key)，mihomo 的 public-key 用这个 */
  peerPublicKey: string;
  /** API 原始 PEM（仅保留用于诊断，不返回前端） */
  peerPublicKeyPem?: string;
  ipv4: string;
  ipv6: string;
  registeredAt: number;
}

export interface WarpLabNode {
  id: string;
  name: string;
  transport: 'h2' | 'h3';
  server: string;
  port: number;
  sni: string;
  /** 完整 mihomo proxy YAML（含私钥；仅用于复制，不在前端表格里直接展示） */
  yaml: string;
  createdAt: number;
}

export interface WarpLabStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface GenerateWarpLabOptions {
  endpoints?: string[];
  sni?: string;
  h2?: boolean;
  h3?: boolean;
}

/** 去掉 PEM 头尾与换行，得到 base64(DER) */
export function normalizePeerKey(raw: string): string {
  const s = String(raw ?? '').trim();
  const m = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(s);
  if (m) return m[1].replace(/\s+/g, '');
  return s.replace(/\s+/g, '');
}

/** 解析 host:port（支持 [v6]:port 与裸 host，默认 443） */
export function parseWarpEndpoint(raw: string): { host: string; port: number } {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('端点不能为空');
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (m) {
    return { host: m[1], port: validatePort(Number(m[2])) };
  }
  const idx = s.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { host: s.slice(0, idx), port: validatePort(Number(s.slice(idx + 1))) };
  }
  return { host: s, port: 443 };
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1-65535');
  return port;
}

function normalizeEndpoints(list: string[] | undefined): { host: string; port: number }[] {
  const raw = Array.isArray(list) && list.length > 0 ? list : WARP_LAB_DEFAULT_ENDPOINTS;
  const out: { host: string; port: number }[] = [];
  const seen = new Set<string>();
  for (const line of raw) {
    for (const part of String(line).split(/[\n,]/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const ep = parseWarpEndpoint(trimmed);
      const key = `${ep.host}:${ep.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ep);
      if (out.length > MASQUE_MAX_ENDPOINTS) {
        throw new Error(`端点最多 ${MASQUE_MAX_ENDPOINTS} 个`);
      }
    }
  }
  if (out.length === 0) throw new Error('至少需要一个端点');
  return out;
}

function yamlQuote(value: string): string {
  return JSON.stringify(String(value));
}

/** 生成 mihomo 可直接使用的 masque 出站 YAML */
export function buildMasqueYaml(
  account: WarpLabAccount,
  node: { name: string; transport: 'h2' | 'h3'; server: string; port: number; sni: string }
): string {
  const lines: string[] = [
    `- name: ${yamlQuote(node.name)}`,
    '  type: masque',
    `  server: ${yamlQuote(node.server)}`,
    `  port: ${node.port}`,
    `  sni: ${yamlQuote(node.sni)}`,
    `  private-key: ${yamlQuote(account.privateKey)}`,
    `  public-key: ${yamlQuote(account.peerPublicKey)}`,
  ];
  if (account.ipv4) lines.push(`  ip: ${yamlQuote(account.ipv4)}`);
  if (account.ipv6) lines.push(`  ipv6: ${yamlQuote(account.ipv6)}`);
  if (node.transport === 'h2') lines.push('  network: h2');
  lines.push(
    '  congestion-controller: bbr',
    '  ip-stack:',
    '    mode: gvisor',
    '  handshake-timeout: 5',
    '  udp: true'
  );
  return lines.join('\n');
}

/** 根据账号与端点生成 H2/H3 节点（不写库，纯函数） */
export function generateMasqueNodes(
  account: WarpLabAccount,
  opts: GenerateWarpLabOptions = {}
): WarpLabNode[] {
  const endpoints = normalizeEndpoints(opts.endpoints);
  const sni = String(opts.sni ?? '').trim() || WARP_LAB_DEFAULT_SNI;
  const wantH2 = opts.h2 !== false;
  const wantH3 = opts.h3 !== false;
  if (!wantH2 && !wantH3) throw new Error('至少选择 H2 或 H3 一种传输');
  const transports: Array<'h2' | 'h3'> = [];
  if (wantH2) transports.push('h2');
  if (wantH3) transports.push('h3');

  const nodes: WarpLabNode[] = [];
  const createdAt = Date.now();
  for (const transport of transports) {
    endpoints.forEach((ep, index) => {
      const name = `WARP-${transport.toUpperCase()}-${String(index + 1).padStart(2, '0')}`;
      nodes.push({
        id: `${transport}-${ep.host}-${ep.port}`,
        name,
        transport,
        server: ep.host,
        port: ep.port,
        sni,
        yaml: buildMasqueYaml(account, { name, transport, server: ep.host, port: ep.port, sni }),
        createdAt,
      });
    });
  }
  return nodes;
}

export interface WarpLabNodeItem {
  server: string;
  port: number;
  transport: 'h2' | 'h3';
}

/**
 * 按「已通过存活验证的端点」逐条生成节点（v2.50.4）。
 * 与 generateMasqueNodes 的区别：每个端点只生成它实际验证通过的传输方式，
 * 不会给一个只测了 H3 的端点再补一个 H2 节点。
 */
export function generateMasqueNodesFromItems(
  account: WarpLabAccount,
  items: WarpLabNodeItem[],
  sni?: string
): WarpLabNode[] {
  const resolvedSni = String(sni ?? '').trim() || WARP_LAB_DEFAULT_SNI;
  const counters = { h2: 0, h3: 0 };
  const seen = new Set<string>();
  const nodes: WarpLabNode[] = [];
  const createdAt = Date.now();
  for (const item of items) {
    const transport: 'h2' | 'h3' = item.transport === 'h2' ? 'h2' : 'h3';
    const server = String(item.server ?? '').trim();
    if (!server) throw new Error('端点地址不能为空');
    const port = validatePort(Number(item.port));
    const id = `${transport}-${server}-${port}`;
    if (seen.has(id)) continue;
    seen.add(id);
    counters[transport]++;
    const name = `WARP-${transport.toUpperCase()}-${String(counters[transport]).padStart(2, '0')}`;
    nodes.push({
      id,
      name,
      transport,
      server,
      port,
      sni: resolvedSni,
      yaml: buildMasqueYaml(account, { name, transport, server, port, sni: resolvedSni }),
      createdAt,
    });
  }
  if (nodes.length === 0) throw new Error('至少需要一个有效端点');
  return nodes;
}

export function maskWarpLabAccount(account: WarpLabAccount): Record<string, unknown> {
  return {
    id: account.id ? `****${account.id.slice(-4)}` : '',
    ipv4: account.ipv4,
    ipv6: account.ipv6,
    registeredAt: account.registeredAt,
  };
}

interface CloudflareRegResponse {
  id?: string;
  token?: string;
  config?: {
    peers?: Array<{ public_key?: string }>;
    interface?: { addresses?: { v4?: string; v6?: string } };
  };
}

async function cfRequest(
  fetchFn: FetchFn,
  method: 'POST' | 'PATCH',
  url: string,
  token: string,
  body: Record<string, unknown>
): Promise<CloudflareRegResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': MASQUE_USER_AGENT,
    'CF-Client-Version': MASQUE_CLIENT_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { method, headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as CloudflareRegResponse;
  } catch {
    throw new Error('Cloudflare API 返回了非 JSON 内容');
  }
}

/**
 * 注册一个 WARP MASQUE 设备（两步：先建 wireguard 占位设备，再换 ECDSA 公钥并切 masque）。
 * 这是匿名设备注册，不是邮箱/密码登录。
 */
export async function registerMasqueDevice(fetchFn: FetchFn): Promise<WarpLabAccount> {
  const first = await cfRequest(fetchFn, 'POST', MASQUE_REG_URL, '', {
    key: randomBytes(32).toString('base64'),
    install_id: '',
    fcm_token: '',
    tos: new Date().toISOString(),
    model: 'PC',
    serial_number: randomBytes(8).toString('base64'),
    os_version: '10',
    key_type: 'curve25519',
    tunnel_type: 'wireguard',
    locale: 'en_US',
  });
  const id = String(first.id ?? '');
  const token = String(first.token ?? '');
  if (!id || !token) throw new Error('WARP 注册响应缺少 id/token');

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privDer = privateKey.export({ type: 'sec1', format: 'der' }) as Buffer;
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const enrolled = await cfRequest(fetchFn, 'PATCH', `${MASQUE_REG_URL}/${id}`, token, {
    key: pubDer.toString('base64'),
    key_type: 'secp256r1',
    tunnel_type: 'masque',
    name: 'SUB-Aggregation WARP Lab',
  });
  const peerPem = String(enrolled?.config?.peers?.[0]?.public_key ?? '');
  if (!peerPem) throw new Error('WARP 注册响应缺少 peer public key');
  const ipv4 = String(enrolled?.config?.interface?.addresses?.v4 ?? '');
  const ipv6 = String(enrolled?.config?.interface?.addresses?.v6 ?? '');

  return {
    id,
    token,
    privateKey: privDer.toString('base64'),
    peerPublicKey: normalizePeerKey(peerPem),
    peerPublicKeyPem: peerPem,
    ipv4,
    ipv6,
    registeredAt: Date.now(),
  };
}

export async function readWarpLabAccount(storage: WarpLabStorage): Promise<WarpLabAccount | null> {
  try {
    const raw = await storage.get(WARP_LAB_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WarpLabAccount;
    return parsed && parsed.privateKey && parsed.peerPublicKey ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveWarpLabAccount(storage: WarpLabStorage, account: WarpLabAccount): Promise<void> {
  await storage.put(WARP_LAB_ACCOUNT_KEY, JSON.stringify(account));
}

export async function readWarpLabNodes(storage: WarpLabStorage): Promise<WarpLabNode[]> {
  try {
    const raw = await storage.get(WARP_LAB_NODES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WarpLabNode[]) : [];
  } catch {
    return [];
  }
}

export async function saveWarpLabNodes(storage: WarpLabStorage, nodes: WarpLabNode[]): Promise<void> {
  await storage.put(WARP_LAB_NODES_KEY, JSON.stringify(nodes));
}

export async function clearWarpLab(storage: WarpLabStorage): Promise<void> {
  await storage.delete(WARP_LAB_ACCOUNT_KEY);
  await storage.delete(WARP_LAB_NODES_KEY);
}
