import { describe, it, expect } from 'vitest';
import { createNode } from '@/models/node';
import { displayProtocol, protocolTagClass } from '@/protocol-display';

function vlessNode(overrides: Record<string, unknown> = {}) {
  return createNode({
    name: 't',
    protocol: 'vless',
    server: 'x.com',
    port: 443,
    uuid: 'u',
    ...overrides,
  } as never);
}

function node(protocol: string) {
  return createNode({
    name: 't',
    protocol: protocol as never,
    server: 'x.com',
    port: 443,
  } as never);
}

describe('displayProtocol - 非 VLESS 全名', () => {
  it('should map SS to Shadowsocks', () => {
    expect(displayProtocol(node('ss'))).toBe('Shadowsocks');
  });
  it('should map SSR to ShadowsocksR', () => {
    expect(displayProtocol(node('ssr'))).toBe('ShadowsocksR');
  });
  it('should map VMess / Trojan', () => {
    expect(displayProtocol(node('vmess'))).toBe('VMess');
    expect(displayProtocol(node('trojan'))).toBe('Trojan');
  });
  it('should map Hysteria2 / TUIC / WireGuard / AnyTLS', () => {
    expect(displayProtocol(node('hysteria2'))).toBe('Hysteria2');
    expect(displayProtocol(node('tuic'))).toBe('TUIC');
    expect(displayProtocol(node('wireguard'))).toBe('WireGuard');
    expect(displayProtocol(node('anytls'))).toBe('AnyTLS');
  });
  it('should map MASQUE / MASQUE H2 / MASQUE H3', () => {
    expect(displayProtocol(node('masque'))).toBe('MASQUE');
    expect(
      displayProtocol(
        createNode({ name: 't', protocol: 'masque', server: 'x.com', port: 443, masqueNetwork: 'h2' })
      )
    ).toBe('MASQUE H2');
    expect(
      displayProtocol(
        createNode({ name: 't', protocol: 'masque', server: 'x.com', port: 443, masqueNetwork: 'h3' })
      )
    ).toBe('MASQUE H3');
  });
  it('should pass unknown protocol through', () => {
    expect(displayProtocol(node('unknown'))).toBe('unknown');
  });
});

describe('displayProtocol - VLESS 官方标准子类型', () => {
  it('plain TCP → VLESS TCP', () => {
    expect(displayProtocol(vlessNode())).toBe('VLESS TCP');
  });
  it('TCP + Reality → VLESS + Reality', () => {
    expect(displayProtocol(vlessNode({ pbk: 'k' }))).toBe('VLESS + Reality');
  });
  it('TCP + Vision → VLESS + XTLS', () => {
    expect(displayProtocol(vlessNode({ flow: 'xtls-rprx-vision' }))).toBe('VLESS + XTLS');
  });
  it('TCP + Reality + Vision → VLESS + Reality + XTLS', () => {
    expect(displayProtocol(vlessNode({ pbk: 'k', flow: 'xtls-rprx-vision' }))).toBe(
      'VLESS + Reality + XTLS'
    );
  });
  it('XHTTP → VLESS + XHTTP', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'xhttp' } }))).toBe('VLESS + XHTTP');
  });
  it('XHTTP + Reality → VLESS + Reality + XHTTP', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'xhttp' }, pbk: 'k' }))).toBe(
      'VLESS + Reality + XHTTP'
    );
  });
  it('XHTTP + Vision(互斥) → VLESS + XHTTP, 忽略 flow', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'xhttp' }, flow: 'xtls-rprx-vision' }))).toBe(
      'VLESS + XHTTP'
    );
  });
  it('WebSocket → VLESS + WebSocket', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'ws' } }))).toBe('VLESS + WebSocket');
  });
  it('WebSocket + Vision(互斥) → VLESS + WebSocket', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'ws' }, flow: 'xtls-rprx-vision' }))).toBe(
      'VLESS + WebSocket'
    );
  });
  it('gRPC → VLESS + gRPC', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'grpc' } }))).toBe('VLESS + gRPC');
  });
  it('gRPC + Reality → VLESS + Reality + gRPC', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'grpc' }, pbk: 'k' }))).toBe(
      'VLESS + Reality + gRPC'
    );
  });
  it('gRPC + Vision(互斥) → VLESS + gRPC', () => {
    expect(displayProtocol(vlessNode({ transport: { type: 'grpc' }, flow: 'xtls-rprx-vision' }))).toBe(
      'VLESS + gRPC'
    );
  });
});

describe('protocolTagClass - 12 色方案', () => {
  it('VLESS 全子类型共享 tag-vless', () => {
    expect(protocolTagClass('vless')).toBe('tag-vless');
  });
  it('其余协议各一色', () => {
    expect(protocolTagClass('ss')).toBe('tag-ss');
    expect(protocolTagClass('ssr')).toBe('tag-ssr');
    expect(protocolTagClass('vmess')).toBe('tag-vmess');
    expect(protocolTagClass('trojan')).toBe('tag-trojan');
    expect(protocolTagClass('hysteria2')).toBe('tag-hysteria2');
    expect(protocolTagClass('tuic')).toBe('tag-tuic');
    expect(protocolTagClass('wireguard')).toBe('tag-wireguard');
    expect(protocolTagClass('anytls')).toBe('tag-anytls');
    expect(protocolTagClass('masque')).toBe('tag-masque');
  });
  it('未知协议归 tag-other', () => {
    expect(protocolTagClass('bogus')).toBe('tag-other');
  });
});
