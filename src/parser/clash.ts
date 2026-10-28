/**
 * Clash/Mihomo YAML 订阅解析器
 * 处理 Clash 格式的订阅内容（proxies: 列表）
 * 支持：vless / vmess / trojan / ss 四种协议
 */

import { Node, createNode, Transport } from '@/models/node';
import { parse as yamlParse } from 'yaml';

interface ClashProxy {
  name: string;
  type: string;
  server: string;
  port: number;
  uuid?: string;
  password?: string;
  cipher?: string;
  tls?: boolean;
  flow?: string;
  sni?: string;
  /** Clash/Mihomo 用 servername 表示 TLS SNI（与 sni 等价） */
  servername?: string;
  'skip-cert-verify'?: boolean;
  'client-fingerprint'?: string;
  network?: string;
  'ws-opts'?: {
    path?: string;
    headers?: Record<string, string>;
  };
  'grpc-opts'?: {
    'grpc-service-name'?: string;
  };
  'xhttp-opts'?: {
    path?: string;
    host?: string;
    mode?: string;
  };
  realityOpts?: {
    'public-key'?: string;
    'short-id'?: string;
    spx?: string;
    'support-x25519mlkem768'?: boolean | string;
  };
  'reality-opts'?: {
    'public-key'?: string;
    'short-id'?: string;
    spx?: string;
    'support-x25519mlkem768'?: boolean | string;
  };
  /** Hysteria2 专用 */
  ports?: string;
  'hop-interval'?: number | string;
  up?: string;
  down?: string;
  obfs?: string;
  'obfs-password'?: string;
  /** TUIC 专用 */
  token?: string;
  'udp-relay-mode'?: string;
  'congestion-controller'?: string;
  'disable-sni'?: boolean;
  'reduce-rtt'?: boolean;
  'fast-open'?: boolean;
  /** WireGuard 专用 */
  ip?: string;
  ipv6?: string;
  'private-key'?: string;
  'public-key'?: string;
  'allowed-ips'?: string[] | string;
  'pre-shared-key'?: string;
  reserved?: number[] | string;
  mtu?: number;
  'remote-dns-resolve'?: boolean;
  dns?: string[];
  /** AnyTLS 专用 */
  'idle-session-check-interval'?: number;
  'idle-session-timeout'?: number;
  'min-idle-session'?: number;
  'client-metadata'?: string;
  /** 通用 TLS */
  alpn?: string[] | string;
  fingerprint?: string;
  method?: string;
  plugin?: string;
  server_port?: number;
}

/**
 * 检测内容是否为 Clash YAML 格式
 */
export function isClashYaml(content: string): boolean {
  const trimmed = content.trim();
  // 检查是否以 proxies: 开头或包含 YAML 格式的代理定义
  return trimmed.startsWith('proxies:') || trimmed.startsWith('port:') || 
         /^proxies:\s*\n/m.test(trimmed) || /^\s+- name:/.test(trimmed);
}

/**
 * 解析 Clash YAML 格式的订阅内容
 */
export function parseClashYaml(content: string): { nodes: Node[]; errors: { line: number; code: string; message: string }[] } {
  const errors: { line: number; code: string; message: string }[] = [];
  const nodes: Node[] = [];

  try {
    const parsed = yamlParse(content) as { proxies?: ClashProxy[] };
    if (!parsed || !Array.isArray(parsed.proxies)) {
      errors.push({ line: 0, code: 'INVALID_FORMAT', message: 'No proxies array in YAML' });
      return { nodes, errors };
    }

    const supportedTypes = ['vless', 'vmess', 'trojan', 'ss'];
    let lineNum = 1;

    for (const proxy of parsed.proxies) {
      lineNum++;
      if (!proxy.name || !proxy.server) {
        errors.push({ line: lineNum, code: 'INVALID_PROXY', message: 'Missing name or server' });
        continue;
      }

      if (!supportedTypes.includes(proxy.type)) {
        errors.push({ line: lineNum, code: 'UNSUPPORTED_TYPE', message: `Unsupported type: ${proxy.type}` });
        continue;
      }

      const node = clashProxyToNode(proxy);
      if (node) {
        nodes.push(node);
      } else {
        errors.push({ line: lineNum, code: 'CONVERSION_FAILED', message: `Failed to convert ${proxy.type} proxy` });
      }
    }
  } catch (err) {
    errors.push({ line: 0, code: 'YAML_PARSE_ERROR', message: (err as Error).message });
  }

  return { nodes, errors };
}

/**
 * 将 Clash proxy 对象转换为统一 Node 模型
 */
function clashProxyToNode(proxy: ClashProxy): Node | null {
  try {
    const { type, server, name, port, uuid, password, cipher, tls, flow, sni } = proxy;
    const serverPort = proxy.server_port || port;
    // Clash/Mihomo 订阅用 servername 表示 SNI；只读 sni 会让 VLESS 节点丢 SNI
    const tlsName = sni || proxy.servername;

    let transport: Transport | undefined;

    switch (type) {
      case 'vless': {
        if (!uuid) return null;
        transport = parseClashTransport(proxy);
        const realityOpts = proxy['reality-opts'] ?? proxy.realityOpts;
        // 保留 mihomo 不支持的扩展字段，供 Xray 链接回写；生成 mihomo 时不会输出 spx
        const realityExtra: Record<string, string> = {};
        if (realityOpts?.spx !== undefined) realityExtra.spx = String(realityOpts.spx);
        if (realityOpts?.['support-x25519mlkem768'] !== undefined) {
          realityExtra['support-x25519mlkem768'] = String(realityOpts['support-x25519mlkem768']);
        }
        return createNode({
          name,
          protocol: 'vless',
          server,
          port: serverPort,
          uuid,
          tls: tls ?? false,
          flow,
          sni: tlsName,
          allowInsecure: proxy['skip-cert-verify'] ?? false,
          pbk: realityOpts?.['public-key'],
          sid: realityOpts?.['short-id'],
          transport,
          metadata: {
            source: 'clash',
            originalName: name,
            tags: [],
            fingerprint: proxy['client-fingerprint'],
            extra: Object.keys(realityExtra).length > 0 ? realityExtra : undefined,
          },
        });
      }

      case 'vmess': {
        if (!uuid) return null;
        transport = parseClashTransport(proxy);
        return createNode({
          name,
          protocol: 'vmess',
          server,
          port: serverPort,
          uuid,
          tls: tls ?? false,
          transport,
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      case 'trojan': {
        if (!password) return null;
        return createNode({
          name,
          protocol: 'trojan',
          server,
          port: serverPort,
          password,
          tls: tls ?? true,
          sni: tlsName || server,
          allowInsecure: proxy['skip-cert-verify'] ?? false,
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      case 'ss': {
        const method = cipher || proxy.method || 'aes-256-gcm';
        if (!password) return null;
        const ssNode = createNode({
          name,
          protocol: 'ss',
          server,
          port: serverPort,
          password,
          plugin: proxy.plugin,
          metadata: { source: 'clash', originalName: name, tags: [method] },
        });
        return ssNode;
      }

      case 'hysteria2': {
        if (!password) return null;
        return createNode({
          name,
          protocol: 'hysteria2',
          server,
          port: serverPort,
          password,
          tls: true,
          sni: tlsName || server,
          allowInsecure: proxy['skip-cert-verify'] ?? false,
          ports: proxy.ports,
          up: proxy.up,
          down: proxy.down,
          obfs: proxy.obfs,
          obfsPassword: proxy['obfs-password'],
          alpn: parseAlpn(proxy.alpn),
          fingerprint: proxy.fingerprint,
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      case 'tuic': {
        // V5: uuid+password; V4: token
        if (!uuid && !proxy.token) return null;
        return createNode({
          name,
          protocol: 'tuic',
          server,
          port: serverPort,
          uuid,
          password,
          token: proxy.token,
          tls: true,
          sni: tlsName || server,
          allowInsecure: proxy['skip-cert-verify'] ?? false,
          udpRelayMode: proxy['udp-relay-mode'],
          congestionController: proxy['congestion-controller'],
          disableSni: proxy['disable-sni'] ?? false,
          reduceRtt: proxy['reduce-rtt'] ?? false,
          fastOpen: proxy['fast-open'] ?? false,
          alpn: parseAlpn(proxy.alpn),
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      case 'wireguard': {
        const privateKey = proxy['private-key'];
        const publicKey = proxy['public-key'];
        if (!privateKey) return null;
        return createNode({
          name,
          protocol: 'wireguard',
          server: server || '',
          port: serverPort || 0,
          tls: false,
          wgIp: proxy.ip,
          wgIpv6: proxy.ipv6,
          wgPrivateKey: privateKey,
          wgPublicKey: publicKey,
          wgAllowedIps: parseAllowedIps(proxy['allowed-ips']) ?? '0.0.0.0/0',
          wgPreSharedKey: proxy['pre-shared-key'],
          wgReserved: parseReserved(proxy.reserved),
          wgMtu: proxy.mtu,
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      case 'anytls': {
        if (!password) return null;
        return createNode({
          name,
          protocol: 'anytls',
          server,
          port: serverPort,
          password,
          tls: true,
          sni: tlsName || server,
          allowInsecure: proxy['skip-cert-verify'] ?? false,
          idleSessionCheckInterval: proxy['idle-session-check-interval'],
          idleSessionTimeout: proxy['idle-session-timeout'],
          minIdleSession: proxy['min-idle-session'],
          clientMetadata: proxy['client-metadata'],
          alpn: parseAlpn(proxy.alpn),
          fingerprint: proxy.fingerprint,
          metadata: { source: 'clash', originalName: name, tags: [] },
        });
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Helper: parse alpn from string or array
function parseAlpn(val: string[] | string | undefined): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.length > 0 ? val : undefined;
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

// Helper: parse allowed-ips from string or array
function parseAllowedIps(val: string[] | string | undefined): string | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.join(',') ;
  return val;
}

// Helper: parse reserved from string or array
function parseReserved(val: number[] | string | undefined): number[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.length > 0 ? val : undefined;
  // string format like "U4An" - not parsed to number[], kept as-is in node.wgReserved
  return undefined;
}

/**
 * 解析 Clash 传输配置
 */
function parseClashTransport(proxy: ClashProxy): Transport | undefined {
  const network = proxy.network || 'tcp';
  if (network === 'tcp') return undefined;

  if (network === 'ws' && proxy['ws-opts']) {
    return {
      type: 'ws',
      path: proxy['ws-opts'].path,
      host: proxy['ws-opts'].headers?.Host,
    };
  }

  if (network === 'grpc' && proxy['grpc-opts']) {
    return {
      type: 'grpc',
      path: proxy['grpc-opts']['grpc-service-name'] 
        ? '/' + proxy['grpc-opts']['grpc-service-name'] 
        : undefined,
    };
  }

  if (network === 'xhttp' && proxy['xhttp-opts']) {
    return {
      type: 'xhttp',
      path: proxy['xhttp-opts'].path,
      host: proxy['xhttp-opts'].host,
      mode: proxy['xhttp-opts'].mode,
    };
  }

  return { type: 'tcp' };
}