import { describe, it, expect } from 'vitest';
import { generateSingboxConfig, nodeToSingboxEndpoint, nodeToSingboxOutbound } from '@/generator/singbox';
import { Node } from '@/models/node';

/**
 * 按 sing-box 1.14/1.15 官方 schema（https://sing-box.sagernet.org/schema.json）
 * 提取的字段白名单。用于防止生成器再写回已删除/拼错的字段。
 */

const DIAL_FIELDS = [
  'detour', 'bind_interface', 'inet4_bind_address', 'inet6_bind_address', 'bind_address_no_port',
  'protect_path', 'routing_mark', 'reuse_addr', 'netns', 'connect_timeout', 'tcp_fast_open',
  'tcp_multi_path', 'disable_tcp_keep_alive', 'tcp_keep_alive', 'tcp_keep_alive_interval',
  'udp_fragment', 'domain_resolver', 'network_strategy', 'network_type', 'fallback_network_type',
  'fallback_delay',
];

const OUTBOUND_FIELDS: Record<string, string[]> = {
  vless: ['type', 'tag', 'server', 'server_port', 'uuid', 'flow', 'network', 'tls', 'multiplex', 'transport', 'packet_encoding'],
  vmess: ['type', 'tag', 'server', 'server_port', 'uuid', 'security', 'alter_id', 'global_padding', 'authenticated_length', 'network', 'tls', 'packet_encoding', 'multiplex', 'transport'],
  trojan: ['type', 'tag', 'server', 'server_port', 'password', 'network', 'tls', 'multiplex', 'transport'],
  shadowsocks: ['type', 'tag', 'server', 'server_port', 'method', 'password', 'plugin', 'plugin_opts', 'network', 'udp_over_tcp', 'multiplex'],
  hysteria2: ['type', 'tag', 'server', 'server_port', 'server_ports', 'hop_interval', 'hop_interval_max', 'up_mbps', 'down_mbps', 'obfs', 'password', 'network', 'tls', 'idle_timeout', 'keep_alive_period', 'stream_receive_window', 'connection_receive_window', 'max_concurrent_streams', 'initial_packet_size', 'disable_path_mtu_discovery', 'bbr_profile', 'brutal_debug', 'disable_chrome_parrot', 'realm'],
  tuic: ['type', 'tag', 'server', 'server_port', 'uuid', 'password', 'congestion_control', 'udp_relay_mode', 'udp_over_stream', 'zero_rtt_handshake', 'heartbeat', 'network', 'tls', 'idle_timeout', 'keep_alive_period', 'stream_receive_window', 'connection_receive_window', 'max_concurrent_streams', 'initial_packet_size', 'disable_path_mtu_discovery'],
  anytls: ['type', 'tag', 'server', 'server_port', 'tls', 'password', 'idle_session_check_interval', 'idle_session_timeout', 'min_idle_session', 'client_metadata'],
  direct: ['type', 'tag'],
  selector: ['type', 'tag', 'outbounds', 'default', 'interrupt_exist_connections'],
  urltest: ['type', 'tag', 'outbounds', 'url', 'interval', 'tolerance', 'idle_timeout', 'interrupt_exist_connections'],
};

const TLS_FIELDS = [
  'enabled', 'engine', 'disable_sni', 'server_name', 'insecure', 'alpn', 'min_version', 'max_version',
  'cipher_suites', 'curve_preferences', 'certificate', 'certificate_path', 'certificate_sha256',
  'certificate_public_key_sha256', 'client_certificate', 'client_certificate_path', 'client_key',
  'client_key_path', 'fragment', 'fragment_fallback_delay', 'record_fragment', 'spoof', 'spoof_method',
  'kernel_tx', 'kernel_rx', 'handshake_timeout', 'ech', 'utls', 'reality',
];

const TRANSPORT_FIELDS: Record<string, string[]> = {
  ws: ['type', 'path', 'headers', 'max_early_data', 'early_data_header_name'],
  grpc: ['type', 'service_name', 'idle_timeout', 'ping_timeout', 'permit_without_stream'],
  http: ['type', 'host', 'path', 'method', 'headers', 'idle_timeout', 'ping_timeout'],
  quic: ['type'],
  httpupgrade: ['type', 'host', 'path', 'headers'],
};

const ENDPOINT_FIELDS = [
  'type', 'tag', 'system', 'name', 'mtu', 'address', 'private_key', 'listen_port', 'peers',
  'udp_timeout', 'udp_mapping', 'udp_filtering', 'udp_nat_max', 'workers', 'on_demand', ...DIAL_FIELDS,
];

const PEER_FIELDS = ['address', 'port', 'public_key', 'pre_shared_key', 'allowed_ips', 'persistent_keepalive_interval', 'reserved'];

const DNS_FIELDS: Record<string, string[]> = {
  https: ['type', 'tag', 'detour', 'server', 'server_port', 'tls', 'path', 'method', 'headers', ...DIAL_FIELDS],
  local: ['type', 'tag', 'prefer_go', 'neighbor_domain', ...DIAL_FIELDS],
};

function assertAllowed(label: string, obj: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unknown field "${key}"`);
  }
}

function assertOutbound(outbound: Record<string, unknown>): void {
  const allowed = OUTBOUND_FIELDS[String(outbound.type)];
  expect(allowed, `unexpected outbound type ${String(outbound.type)}`).toBeTruthy();
  assertAllowed(`outbound ${String(outbound.tag)}`, outbound, allowed);
  if (outbound.tls) assertAllowed(`outbound ${String(outbound.tag)}.tls`, outbound.tls as Record<string, unknown>, TLS_FIELDS);
  if (outbound.transport) {
    const transport = outbound.transport as Record<string, unknown>;
    assertAllowed(`outbound ${String(outbound.tag)}.transport`, transport, TRANSPORT_FIELDS[String(transport.type)] ?? []);
  }
  if (!['direct', 'selector', 'urltest'].includes(String(outbound.type))) {
    expect(typeof outbound.server).toBe('string');
    expect(Number.isInteger(outbound.server_port)).toBe(true);
  }
}

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    name: 'N1',
    protocol: 'vless',
    server: 'example.com',
    port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tls: true,
    sni: 'example.com',
    metadata: { source: 'test', originalName: 'N1', tags: [] },
    version: 1,
    ...overrides,
  } as Node;
}

const NODES: Node[] = [
  makeNode({ name: 'VMESS', protocol: 'vmess', transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' }, metadata: { source: 't', originalName: 'V', tags: ['aes-128-gcm'] } }),
  makeNode({ name: 'VLESS-R', pbk: 'pk', sid: 'ab', flow: 'xtls-rprx-vision', transport: { type: 'tcp' }, metadata: { source: 't', originalName: 'V', tags: [], fingerprint: 'chrome' } }),
  makeNode({ name: 'VLESS-G', transport: { type: 'grpc', path: '/svc' } }),
  makeNode({ name: 'TROJAN', protocol: 'trojan', password: 'pw', allowInsecure: true }),
  makeNode({ name: 'SS', protocol: 'ss', password: 'pw', metadata: { source: 't', originalName: 'S', tags: ['aes-256-gcm'] } }),
  makeNode({ name: 'HY2', protocol: 'hysteria2', password: 'pw', ports: '443-8443', up: '100 Mbps', down: '200 Mbps', obfs: 'salamander', obfsPassword: 'op', alpn: ['h3'] }),
  makeNode({ name: 'TUIC', protocol: 'tuic', uuid: 'u', password: 'pw', congestionController: 'bbr', reduceRtt: true, disableSni: true, alpn: ['h3'] }),
  makeNode({ name: 'ANYTLS', protocol: 'anytls', password: 'pw', idleSessionCheckInterval: 30, idleSessionTimeout: 60, minIdleSession: 2 }),
  makeNode({ name: 'WG', protocol: 'wireguard', wgPrivateKey: 'priv', wgPublicKey: 'pub', wgIp: '10.0.0.2', wgIpv6: 'fd00::2' }),
];

describe('sing-box schema conformance', () => {
  it('all generated outbounds only use schema fields', () => {
    for (const node of NODES) {
      const outbound = nodeToSingboxOutbound(node);
      if (!outbound) continue;
      assertOutbound(outbound);
    }
  });

  it('wireguard uses endpoint schema fields', () => {
    const endpoint = nodeToSingboxEndpoint(NODES.find((n) => n.protocol === 'wireguard')!)!;
    expect(endpoint.type).toBe('wireguard');
    assertAllowed('wireguard endpoint', endpoint, ENDPOINT_FIELDS);
    for (const peer of endpoint.peers as Record<string, unknown>[]) {
      assertAllowed('wireguard peer', peer, PEER_FIELDS);
    }
  });

  it('full config uses schema-compatible DNS, outbounds and endpoints', () => {
    const config = JSON.parse(generateSingboxConfig(NODES));
    for (const server of config.dns.servers as Record<string, unknown>[]) {
      assertAllowed('dns server', server, DNS_FIELDS[String(server.type)] ?? []);
    }
    for (const outbound of config.outbounds as Record<string, unknown>[]) assertOutbound(outbound);
    for (const endpoint of config.endpoints as Record<string, unknown>[]) {
      assertAllowed('endpoint', endpoint, ENDPOINT_FIELDS);
      for (const peer of endpoint.peers as Record<string, unknown>[]) assertAllowed('peer', peer, PEER_FIELDS);
    }
  });

  it('duration fields are strings', () => {
    const config = JSON.parse(generateSingboxConfig(NODES));
    for (const outbound of config.outbounds as Record<string, unknown>[]) {
      for (const key of ['hop_interval', 'heartbeat', 'idle_session_check_interval', 'idle_session_timeout']) {
        if (key in outbound) expect(typeof outbound[key], `${String(outbound.tag)}.${key}`).toBe('string');
      }
    }
  });
});
