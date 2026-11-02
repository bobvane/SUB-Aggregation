import { describe, it, expect } from 'vitest';
import {
  generateSingboxConfig,
  nodeToSingboxEndpoint,
  nodeToSingboxOutbound,
  validateSingbox,
} from '@/generator/singbox';
import { Node } from '@/models/node';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    name: 'JP-01',
    protocol: 'vless',
    server: 'jp.example.com',
    port: 443,
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    tls: true,
    metadata: { source: 'test', originalName: 'JP-01', tags: [] },
    version: 1,
    ...overrides,
  } as Node;
}

describe('nodeToSingboxOutbound', () => {
  it('should convert vless node', () => {
    const out = nodeToSingboxOutbound(makeNode());
    expect(out).not.toBeNull();
    expect(out!.type).toBe('vless');
    expect(out!.tag).toBe('JP-01');
    expect(out!.server).toBe('jp.example.com');
    expect(out!.server_port).toBe(443);
    expect(out!.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect((out!.tls as Record<string, unknown>).enabled).toBe(true);
  });

  it('should convert vmess with ws transport and security', () => {
    const out = nodeToSingboxOutbound(
      makeNode({
        protocol: 'vmess',
        transport: { type: 'ws', path: '/ws', host: 'cdn.example.com' },
        metadata: { source: 'test', originalName: 'VM', tags: ['aes-128-gcm'] },
      })
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe('vmess');
    expect(out!.security).toBe('aes-128-gcm');
    expect(out!.method).toBeUndefined();
    expect((out!.transport as Record<string, unknown>).type).toBe('ws');
  });

  it('should not emit a tcp transport for reality nodes', () => {
    const out = nodeToSingboxOutbound(
      makeNode({
        pbk: 'pubkey',
        sid: 'sid123',
        sni: 'real.com',
        transport: { type: 'tcp', host: 'real.com' },
        flow: 'xtls-rprx-vision',
      })
    );
    expect(out).not.toBeNull();
    expect(out!.transport).toBeUndefined();
    expect((out!.tls as Record<string, unknown>).reality).toBeTruthy();
  });

  it('should map grpc path to service_name', () => {
    const out = nodeToSingboxOutbound(makeNode({ transport: { type: 'grpc', path: '/svc' } }));
    expect((out!.transport as Record<string, unknown>).service_name).toBe('svc');
  });

  it('should map h2 transport to http', () => {
    const out = nodeToSingboxOutbound(
      makeNode({ transport: { type: 'h2', path: '/h2', host: 'h2.example.com' } })
    );
    const transport = out!.transport as Record<string, unknown>;
    expect(transport.type).toBe('http');
    expect(transport.host).toBe('h2.example.com');
  });

  it('should convert trojan with tls and insecure', () => {
    const out = nodeToSingboxOutbound(
      makeNode({ protocol: 'trojan', password: 'pw', allowInsecure: true })
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe('trojan');
    expect(out!.password).toBe('pw');
    expect((out!.tls as Record<string, unknown>).insecure).toBe(true);
  });

  it('should convert ss to shadowsocks with method', () => {
    const out = nodeToSingboxOutbound(
      makeNode({
        protocol: 'ss',
        password: 'p',
        metadata: { source: 'test', originalName: 'SS', tags: ['chacha20-ietf-poly1305'] },
      })
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe('shadowsocks');
    expect(out!.method).toBe('chacha20-ietf-poly1305');
    expect(out!.password).toBe('p');
  });

  it('should include reality tls config', () => {
    const out = nodeToSingboxOutbound(
      makeNode({ pbk: 'pubkey', sid: 'sid123', sni: 'real.com' })
    );
    expect(out).not.toBeNull();
    const tls = out!.tls as Record<string, unknown>;
    expect(tls.reality).toBeTruthy();
    expect((tls.reality as Record<string, unknown>).public_key).toBe('pubkey');
    expect((tls.utls as Record<string, unknown>).enabled).toBe(true);
  });

  it('should convert hysteria2 node with correct field names', () => {
    const node = makeNode({
      protocol: 'hysteria2',
      password: 'hy2pw',
      sni: 'hy.example.com',
      allowInsecure: true,
      ports: '443-8443',
      obfs: 'salamander',
      obfsPassword: 'obfspw',
      up: '100 Mbps',
      down: '200 Mbps',
      alpn: ['h3'],
    });
    const out = nodeToSingboxOutbound(node);
    expect(out).not.toBeNull();
    expect(out!.type).toBe('hysteria2');
    expect(out!.password).toBe('hy2pw');
    expect(out!.server_ports).toEqual(['443:8443']);
    expect(out!.up_mbps).toBe(100);
    expect(out!.down_mbps).toBe(200);
    expect(out!.ports).toBeUndefined();
    expect(out!.sni).toBeUndefined();
    expect(out!.insecure).toBeUndefined();
    const tls = out!.tls as Record<string, unknown>;
    expect(tls.server_name).toBe('hy.example.com');
    expect(tls.insecure).toBe(true);
    expect(tls.alpn).toEqual(['h3']);
    const obfs = out!.obfs as Record<string, unknown>;
    expect(obfs?.type).toBe('salamander');
    expect(obfs?.password).toBe('obfspw');
  });

  it('should convert tuic node with tls options', () => {
    const node = makeNode({
      protocol: 'tuic',
      uuid: 'uuid1',
      password: 'pw1',
      sni: 'tuic.example.com',
      congestionController: 'bbr',
      disableSni: true,
      reduceRtt: true,
      fastOpen: true,
      alpn: ['h3'],
    });
    const out = nodeToSingboxOutbound(node);
    expect(out).not.toBeNull();
    expect(out!.type).toBe('tuic');
    expect(out!.uuid).toBe('uuid1');
    expect(out!.password).toBe('pw1');
    expect(out!.congestion_control).toBe('bbr');
    expect(out!.zero_rtt_handshake).toBe(true);
    expect(out!.tcp_fast_open).toBe(true);
    const tls = out!.tls as Record<string, unknown>;
    expect(tls.disable_sni).toBe(true);
    expect(tls.server_name).toBe('tuic.example.com');
    expect(tls.alpn).toEqual(['h3']);
  });

  it('should skip TUIC V4 token nodes (unsupported by sing-box)', () => {
    const out = nodeToSingboxOutbound(
      makeNode({ protocol: 'tuic', uuid: undefined, token: 'v4-token' })
    );
    expect(out).toBeNull();
  });

  it('should convert wireguard node to endpoint', () => {
    const node = makeNode({
      protocol: 'wireguard',
      wgPrivateKey: 'wgpriv',
      wgPublicKey: 'wgpub',
      wgIp: '10.0.0.2',
      wgIpv6: 'fd00::2',
      wgMtu: 1400,
      wgAllowedIps: '0.0.0.0/0,::/0',
    });
    expect(nodeToSingboxOutbound(node)).toBeNull();
    const out = nodeToSingboxEndpoint(node);
    expect(out).not.toBeNull();
    expect(out!.type).toBe('wireguard');
    expect(out!.private_key).toBe('wgpriv');
    expect(out!.address).toEqual(['10.0.0.2/32', 'fd00::2/128']);
    expect(out!.mtu).toBe(1400);
    const peers = out!.peers as Record<string, unknown>[];
    expect(peers[0].public_key).toBe('wgpub');
    expect(peers[0].allowed_ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('should convert anytls node with tls object and duration strings', () => {
    const node = makeNode({
      protocol: 'anytls',
      password: 'apw',
      sni: 'anytls.example.com',
      clientMetadata: 'cmd',
      idleSessionCheckInterval: 30,
      idleSessionTimeout: 60,
      minIdleSession: 2,
    });
    const out = nodeToSingboxOutbound(node);
    expect(out).not.toBeNull();
    expect(out!.type).toBe('anytls');
    expect(out!.password).toBe('apw');
    expect(out!.sni).toBeUndefined();
    expect(out!.client_metadata).toBe('cmd');
    expect(out!.idle_session_check_interval).toBe('30s');
    expect(out!.idle_session_timeout).toBe('60s');
    expect(out!.min_idle_session).toBe(2);
    const tls = out!.tls as Record<string, unknown>;
    expect(tls.enabled).toBe(true);
    expect(tls.server_name).toBe('anytls.example.com');
  });
});

describe('generateSingboxConfig', () => {
  it('should generate valid JSON with outbounds', () => {
    const json = generateSingboxConfig([makeNode()]);
    expect(validateSingbox(json)).toBe(true);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.outbounds)).toBe(true);
  });

  it('should include standard outbounds', () => {
    const json = generateSingboxConfig([makeNode()]);
    const parsed = JSON.parse(json);
    const tags = parsed.outbounds.map((o: Record<string, unknown>) => o.tag);
    expect(tags).toContain('direct');
    expect(tags).not.toContain('block');
    expect(tags).toContain('proxy');
    expect(tags).toContain('auto');
  });

  it('should include node outbound', () => {
    const json = generateSingboxConfig([makeNode({ name: 'JP-01' })]);
    const parsed = JSON.parse(json);
    const tags = parsed.outbounds.map((o: Record<string, unknown>) => o.tag);
    expect(tags).toContain('JP-01');
  });

  it('should include route final proxy', () => {
    const json = generateSingboxConfig([makeNode()]);
    const parsed = JSON.parse(json);
    expect(parsed.route.final).toBe('proxy');
  });

  it('should use schema-compatible DNS servers', () => {
    const json = generateSingboxConfig([makeNode()]);
    const parsed = JSON.parse(json);
    expect(parsed.dns.servers).toEqual([
      { type: 'https', tag: 'dns-proxy', server: '1.1.1.1', detour: 'proxy' },
      { type: 'https', tag: 'dns-direct', server: '223.5.5.5', detour: 'direct' },
      { type: 'local', tag: 'dns-local' },
    ]);
  });

  it('should emit wireguard as top-level endpoint and reference its tag', () => {
    const wg = makeNode({
      name: 'WG',
      protocol: 'wireguard',
      wgPrivateKey: 'priv',
      wgPublicKey: 'pub',
      wgIp: '10.0.0.2',
    });
    const parsed = JSON.parse(generateSingboxConfig([wg]));
    expect(parsed.endpoints).toHaveLength(1);
    expect(parsed.endpoints[0].tag).toBe('WG');
    expect(parsed.outbounds.some((o: Record<string, unknown>) => o.type === 'wireguard')).toBe(false);
    const selector = parsed.outbounds.find((o: Record<string, unknown>) => o.tag === 'proxy');
    expect(selector.outbounds).toContain('WG');
    const auto = parsed.outbounds.find((o: Record<string, unknown>) => o.tag === 'auto');
    expect(auto.outbounds).toContain('WG');
  });

  it('should not reference skipped nodes from selector / urltest', () => {
    const nodes = [
      makeNode({ name: 'OK' }),
      makeNode({ name: 'SSR', protocol: 'ssr' }),
      makeNode({ name: 'XHTTP', transport: { type: 'xhttp', path: '/' } }),
      makeNode({ name: 'TUIC4', protocol: 'tuic', uuid: undefined, token: 't4' }),
    ];
    const parsed = JSON.parse(generateSingboxConfig(nodes));
    const tags = new Set(parsed.outbounds.map((o: Record<string, unknown>) => o.tag));
    expect(tags).toContain('OK');
    expect(tags).not.toContain('SSR');
    expect(tags).not.toContain('XHTTP');
    expect(tags).not.toContain('TUIC4');
    for (const group of parsed.outbounds.filter((o: Record<string, unknown>) => Array.isArray(o.outbounds))) {
      for (const ref of group.outbounds as string[]) expect(tags.has(ref)).toBe(true);
    }
  });

  it('should handle empty node list', () => {
    const json = generateSingboxConfig([]);
    expect(validateSingbox(json)).toBe(true);
    const parsed = JSON.parse(json);
    const tags = parsed.outbounds.map((o: Record<string, unknown>) => o.tag);
    expect(tags).toContain('direct');
  });

  it('should be pretty-printed JSON', () => {
    const json = generateSingboxConfig([makeNode()]);
    expect(json).toContain('\n');
    expect(json).toContain('  "log"');
  });

  it('should skip ssr protocol nodes', () => {
    const json = generateSingboxConfig([makeNode({ protocol: 'ssr' }), makeNode({ name: 'A' })]);
    const parsed = JSON.parse(json);
    const tags = parsed.outbounds.map((o: Record<string, unknown>) => o.tag);
    expect(tags).not.toContain('ssr');
    expect(tags).toContain('A');
  });
});
