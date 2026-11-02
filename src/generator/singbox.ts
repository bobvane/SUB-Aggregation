/**
 * Sing-box 配置生成器
 * TASK 5.2 - Sing-box Generator
 * 09_CONFIG_GENERATOR_SPEC.md §8：输出 JSON，outbounds 映射
 *
 * v2.42.0：按 sing-box 1.14/1.15 官方 schema 重写字段映射
 * - DNS server 使用新格式（type: https/local），旧 address 格式已在 1.14 移除
 * - tcp 不输出 transport（sing-box 没有 tcp transport），gRPC 用 service_name，h2 映射 http
 * - VMess security / Shadowsocks type=shadowsocks / WireGuard 改 endpoints
 * - Hysteria2 / TUIC / AnyTLS 的 TLS 字段归位，时长字段统一为字符串
 * - ssr 与 xhttp 传输节点无法被 sing-box 表达，直接跳过
 */

import { Node } from '@/models/node';
import { makeUniqueNames } from './mihomo';

export interface SingboxTemplate {
  logLevel?: string;
}

export const DEFAULT_SINGBOX_TEMPLATE: SingboxTemplate = {
  logLevel: 'info',
};

type JsonObject = Record<string, unknown>;

/** sing-box 无法表达的协议/传输 */
function isUnsupportedNode(node: Node): boolean {
  if (node.protocol === 'ssr') return true;
  if (node.transport?.type === 'xhttp') return true;
  // sing-box 仅支持 TUIC V5（uuid + password），V4 的 token 没有对应字段
  if (node.protocol === 'tuic' && !node.uuid && !!node.token) return true;
  return false;
}

/**
 * 将 Node 转换为 Sing-box outbound 配置对象
 * WireGuard 自 1.13 起改为顶层 endpoint，由 nodeToSingboxEndpoint 处理。
 * 返回 null 表示该节点无法用 sing-box 表达。
 */
export function nodeToSingboxOutbound(node: Node): JsonObject | null {
  if (isUnsupportedNode(node)) return null;
  switch (node.protocol) {
    case 'vmess':
      return buildVmess(node);
    case 'vless':
      return buildVless(node);
    case 'trojan':
      return buildTrojan(node);
    case 'ss':
      return buildShadowsocks(node);
    case 'hysteria2':
      return buildHysteria2(node);
    case 'tuic':
      return buildTuic(node);
    case 'anytls':
      return buildAnytls(node);
    default:
      return null;
  }
}

/**
 * 将 WireGuard 节点转换为 Sing-box endpoint（1.13+）
 */
export function nodeToSingboxEndpoint(node: Node): JsonObject | null {
  if (node.protocol !== 'wireguard') return null;
  const address: string[] = [];
  if (node.wgIp) address.push(withPrefix(node.wgIp, 32));
  if (node.wgIpv6) address.push(withPrefix(node.wgIpv6, 128));

  const peer: JsonObject = {
    address: node.server,
    port: node.port,
    public_key: node.wgPublicKey ?? '',
  };
  if (node.wgPreSharedKey) peer.pre_shared_key = node.wgPreSharedKey;
  if (node.wgAllowedIps) {
    peer.allowed_ips = node.wgAllowedIps
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    peer.allowed_ips = ['0.0.0.0/0', '::/0'];
  }
  if (node.wgReserved?.length) peer.reserved = node.wgReserved;
  const keepalive = node.metadata?.extra?.['persistent-keepalive'];
  if (keepalive) {
    const seconds = parseInt(keepalive, 10);
    if (Number.isFinite(seconds) && seconds > 0) peer.persistent_keepalive_interval = seconds;
  }

  const endpoint: JsonObject = {
    type: 'wireguard',
    tag: node.name,
    private_key: node.wgPrivateKey ?? '',
    peers: [peer],
  };
  if (address.length > 0) endpoint.address = address;
  if (node.wgMtu) endpoint.mtu = node.wgMtu;
  return endpoint;
}

// ── VMess ───────────────────────────────────────────────────────────────────

function buildVmess(n: Node): JsonObject {
  const out: JsonObject = { type: 'vmess', tag: n.name, server: n.server, server_port: n.port };
  if (n.uuid) out.uuid = n.uuid;
  // 加密方式在解析器中写在 tags[0]；sing-box 字段名为 security
  if (n.metadata?.tags?.[0]) out.security = n.metadata.tags[0];
  const transport = buildTransport(n);
  if (transport) out.transport = transport;
  const tls = buildTls(n);
  if (tls) out.tls = tls;
  if (n.fastOpen) out.tcp_fast_open = true;
  if (n.metadata?.extra?.['packet-encoding']) out.packet_encoding = n.metadata.extra['packet-encoding'];
  if (n.metadata?.extra?.['global-padding']) out.global_padding = true;
  if (n.metadata?.extra?.['authenticated-length']) out.authenticated_length = true;
  return out;
}

// ── VLESS ───────────────────────────────────────────────────────────────────

function buildVless(n: Node): JsonObject {
  const out: JsonObject = { type: 'vless', tag: n.name, server: n.server, server_port: n.port };
  if (n.uuid) out.uuid = n.uuid;
  if (n.flow) out.flow = n.flow;
  const transport = buildTransport(n);
  if (transport) out.transport = transport;
  const tls = buildTls(n);
  if (tls) out.tls = tls;
  if (n.fastOpen) out.tcp_fast_open = true;
  if (n.metadata?.extra?.['packet-encoding']) out.packet_encoding = n.metadata.extra['packet-encoding'];
  return out;
}

// ── Trojan ──────────────────────────────────────────────────────────────────

function buildTrojan(n: Node): JsonObject {
  const out: JsonObject = { type: 'trojan', tag: n.name, server: n.server, server_port: n.port };
  if (n.password) out.password = n.password;
  // Trojan 始终走 TLS
  const tls = buildTls(n, true);
  if (tls) out.tls = tls;
  const transport = buildTransport(n);
  if (transport) out.transport = transport;
  if (n.fastOpen) out.tcp_fast_open = true;
  return out;
}

// ── Shadowsocks ─────────────────────────────────────────────────────────────

function buildShadowsocks(n: Node): JsonObject {
  const method = n.metadata?.tags?.[0] || n.username || 'aes-256-gcm';
  const out: JsonObject = {
    type: 'shadowsocks',
    tag: n.name,
    server: n.server,
    server_port: n.port,
    method,
    password: n.password,
  };
  if (n.plugin) {
    const pluginParts = n.plugin.split(';');
    out.plugin = pluginParts[0];
    const opts: Record<string, string> = {};
    for (const part of pluginParts.slice(1)) {
      if (part.includes('=')) {
        const [k, v] = part.split('=');
        opts[k] = v;
      } else {
        opts.mode = part;
      }
    }
    if (Object.keys(opts).length > 0) out.plugin_opts = formatPluginOpts(opts);
  }
  if (n.fastOpen) out.tcp_fast_open = true;
  return out;
}

// ── Hysteria2 ───────────────────────────────────────────────────────────────

function buildHysteria2(n: Node): JsonObject {
  const out: JsonObject = {
    type: 'hysteria2',
    tag: n.name,
    server: n.server,
    server_port: n.port,
  };
  if (n.password) out.password = n.password;
  const serverPorts = parsePortRanges(n.ports);
  if (serverPorts) out.server_ports = serverPorts;
  const up = parseMbps(n.up);
  const down = parseMbps(n.down);
  if (up !== undefined) out.up_mbps = up;
  if (down !== undefined) out.down_mbps = down;
  if (n.obfs === 'salamander' || n.obfs === 'gecko') {
    const obfs: JsonObject = { type: n.obfs };
    if (n.obfsPassword) obfs.password = n.obfsPassword;
    out.obfs = obfs;
  }
  const tls = buildTls(n, true);
  if (tls) out.tls = tls;
  if (n.fastOpen) out.tcp_fast_open = true;
  if (n.metadata?.extra?.['disable-mtu-discovery']) out.disable_path_mtu_discovery = true;
  const hopInterval = n.metadata?.extra?.['hop-interval'];
  if (hopInterval) out.hop_interval = toDuration(hopInterval);
  return out;
}

// ── TUIC ────────────────────────────────────────────────────────────────────

function buildTuic(n: Node): JsonObject {
  const out: JsonObject = {
    type: 'tuic',
    tag: n.name,
    server: n.server,
    server_port: n.port,
    uuid: n.uuid,
  };
  if (n.password) out.password = n.password;
  if (n.congestionController) out.congestion_control = n.congestionController;
  if (n.udpRelayMode) out.udp_relay_mode = n.udpRelayMode;
  // reduce-rtt 在新版 sing-box 中对应 zero_rtt_handshake
  if (n.reduceRtt) out.zero_rtt_handshake = true;
  const tls = buildTls(n, true);
  if (tls) {
    if (n.disableSni) tls.disable_sni = true;
    out.tls = tls;
  }
  const heartbeat = n.metadata?.extra?.['heartbeat-interval'];
  if (heartbeat) out.heartbeat = toDuration(heartbeat);
  if (n.fastOpen) out.tcp_fast_open = true;
  return out;
}

// ── AnyTLS ──────────────────────────────────────────────────────────────────

function buildAnytls(n: Node): JsonObject {
  const out: JsonObject = {
    type: 'anytls',
    tag: n.name,
    server: n.server,
    server_port: n.port,
    password: n.password,
  };
  const tls = buildTls(n, true);
  if (tls) out.tls = tls;
  if (n.clientMetadata) out.client_metadata = n.clientMetadata;
  const checkInterval = toDuration(n.idleSessionCheckInterval);
  if (checkInterval) out.idle_session_check_interval = checkInterval;
  const timeout = toDuration(n.idleSessionTimeout);
  if (timeout) out.idle_session_timeout = timeout;
  if (n.minIdleSession !== undefined) out.min_idle_session = n.minIdleSession;
  return out;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 构建 transport；tcp / 无传输返回 undefined，xhttp 返回 null 表示无法表达 */
function buildTransport(n: Node): JsonObject | null | undefined {
  const t = n.transport;
  if (!t || t.type === 'tcp') return undefined;
  if (t.type === 'xhttp') return null;

  if (t.type === 'ws') {
    const transport: JsonObject = { type: 'ws' };
    if (t.path) transport.path = t.path;
    if (t.host) transport.headers = { Host: t.host };
    return transport;
  }
  if (t.type === 'grpc') {
    const transport: JsonObject = { type: 'grpc' };
    const serviceName = (t.path ?? '').replace(/^\/+/, '');
    if (serviceName) transport.service_name = serviceName;
    return transport;
  }
  // h2 → sing-box 的 http transport
  const transport: JsonObject = { type: 'http' };
  if (t.path) transport.path = t.path;
  if (t.host) transport.host = t.host;
  return transport;
}

/** 构建 TLS 对象；allowInsecure 等字段统一放在 tls 内 */
function buildTls(n: Node, force = false): JsonObject | undefined {
  if (!force && !n.tls && !n.pbk) return undefined;
  const tls: JsonObject = { enabled: true };
  const serverName = n.sni ?? n.server;
  if (serverName) tls.server_name = serverName;
  if (n.allowInsecure) tls.insecure = true;
  if (n.alpn?.length) tls.alpn = n.alpn;

  const fingerprint = n.fingerprint ?? n.metadata?.fingerprint;
  if (n.pbk) {
    // REALITY 依赖 uTLS：没有显式指纹时用 chrome
    tls.utls = { enabled: true, fingerprint: fingerprint ?? 'chrome' };
    const reality: JsonObject = { enabled: true, public_key: n.pbk };
    if (n.sid) reality.short_id = n.sid;
    tls.reality = reality;
  } else if (fingerprint) {
    tls.utls = { enabled: true, fingerprint };
  }
  return tls;
}

/** "443-8443,9000" → ["443:8443", "9000"] */
function parsePortRanges(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const ports = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/-/g, ':'));
  return ports.length > 0 ? ports : undefined;
}

/** "30 Mbps" / "30" → 30 */
function parseMbps(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  if (!match) return undefined;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 数字秒数 → sing-box Duration 字符串 */
function toDuration(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return `${value}s`;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? `${trimmed}s` : trimmed;
}

/** 给 IP 补前缀长度（sing-box endpoint.address 要求前缀） */
function withPrefix(value: string, defaultPrefix: number): string {
  const trimmed = value.trim();
  if (trimmed.includes('/')) return trimmed;
  return `${trimmed}/${defaultPrefix}`;
}

function formatPluginOpts(opts: Record<string, string>): string {
  return Object.entries(opts)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

/**
 * 生成 Sing-box JSON 配置（含 DNS/路由/TUN 的完整配置）
 */
export function generateSingboxConfig(nodes: Node[], template: SingboxTemplate = DEFAULT_SINGBOX_TEMPLATE): string {
  const uniqueNodes = makeUniqueNames(nodes).filter((n) => !isUnsupportedNode(n));

  const nodeOutbounds: JsonObject[] = [];
  const endpoints: JsonObject[] = [];
  for (const node of uniqueNodes) {
    if (node.protocol === 'wireguard') {
      const endpoint = nodeToSingboxEndpoint(node);
      if (endpoint) endpoints.push(endpoint);
      continue;
    }
    const outbound = nodeToSingboxOutbound(node);
    if (outbound) nodeOutbounds.push(outbound);
  }

  // 只引用实际输出的 tag，避免 selector / urltest 指向不存在的 outbound
  const nodeTags = [...nodeOutbounds, ...endpoints].map((item) => String(item.tag));

  const outbounds: JsonObject[] = [
    { type: 'direct', tag: 'direct' },
    ...nodeOutbounds,
    {
      type: 'selector',
      tag: 'proxy',
      outbounds: ['auto', ...nodeTags],
      default: nodeTags.length > 0 ? 'auto' : 'direct',
    },
    {
      type: 'urltest',
      tag: 'auto',
      outbounds: nodeTags.length > 0 ? nodeTags : ['direct'],
      url: 'https://cp.cloudflare.com/generate_204',
      interval: '10m',
      tolerance: 50,
    },
  ];

  const config: JsonObject = {
    log: { level: template.logLevel ?? 'info' },
    dns: {
      servers: [
        { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'proxy' },
        { type: 'https', tag: 'dns-direct', server: '223.5.5.5', detour: 'direct' },
        { type: 'local', tag: 'dns-local' },
      ],
      final: 'dns-proxy',
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 },
    ],
    outbounds,
    ...(endpoints.length > 0 ? { endpoints } : {}),
    route: {
      final: 'proxy',
      auto_detect_interface: true,
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        { clash_mode: 'Direct', outbound: 'direct' },
        { clash_mode: 'Global', outbound: 'proxy' },
      ],
    },
    experimental: { cache_file: { enabled: true } },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * 验证生成的 JSON 基本结构。
 * 只做轻量自检（完整字段级校验见 tests/generator/singbox-schema.test.ts）。
 */
export function validateSingbox(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as JsonObject;
    if (!parsed || !Array.isArray(parsed.outbounds)) return false;
    if (parsed.endpoints !== undefined && !Array.isArray(parsed.endpoints)) return false;

    const tags = new Set<string>();
    for (const item of [...(parsed.outbounds as JsonObject[]), ...((parsed.endpoints as JsonObject[] | undefined) ?? [])]) {
      if (!item || typeof item.type !== 'string' || typeof item.tag !== 'string') return false;
      if (tags.has(item.tag)) return false;
      tags.add(item.tag);
    }

    const dns = parsed.dns as JsonObject | undefined;
    const servers = dns?.servers as JsonObject[] | undefined;
    if (!Array.isArray(servers)) return false;
    if (servers.some((server) => typeof server.type !== 'string')) return false;

    for (const outbound of parsed.outbounds as JsonObject[]) {
      const refs = outbound.outbounds;
      if (Array.isArray(refs) && refs.some((ref) => !tags.has(String(ref)))) return false;
      if (outbound.type === 'wireguard') return false;
      const transport = outbound.transport as JsonObject | undefined;
      if (transport && !['http', 'ws', 'quic', 'grpc', 'httpupgrade'].includes(String(transport.type))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
