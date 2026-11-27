/**
 * v2.50.5：Clash YAML 解析支持 MASQUE（H2/H3），并修正白名单只认 4 种协议的问题。
 */
import { describe, it, expect } from 'vitest';
import { parseSubscriptionContent } from '@/parser/index';

const YAML = `proxies:
- name: WARP-H3
  type: masque
  server: 162.159.198.1
  port: 443
  sni: consumer-masque.cloudflareclient.com
  private-key: PRIV-H3
  public-key: PUB
  ip: 172.16.0.2
  ipv6: fd01::2
  congestion-controller: bbr
  ip-stack:
    mode: gvisor
  handshake-timeout: 5
  udp: true
- name: WARP-H2
  type: masque
  server: 162.159.198.2
  port: 8443
  sni: consumer-masque.cloudflareclient.com
  private-key: PRIV-H2
  public-key: PUB
  network: h2
- name: HY2
  type: hysteria2
  server: hy.example.com
  port: 443
  password: pw
`;

describe('Clash YAML MASQUE', () => {
  it('H3 节点字段完整（无 network）', () => {
    const result = parseSubscriptionContent(YAML, 'test');
    const node = result.nodes.find((n) => n.name === 'WARP-H3');
    expect(node?.protocol).toBe('masque');
    expect(node?.masqueNetwork).toBe('h3');
    expect(node?.masquePrivateKey).toBe('PRIV-H3');
    expect(node?.masquePublicKey).toBe('PUB');
    expect(node?.masqueIp).toBe('172.16.0.2');
    expect(node?.masqueIpv6).toBe('fd01::2');
    expect(node?.masqueCongestionController).toBe('bbr');
    expect(node?.masqueIpStack).toBe('gvisor');
    expect(node?.masqueHandshakeTimeout).toBe(5);
    expect(node?.masqueUdp).toBe(true);
    expect(node?.sni).toBe('consumer-masque.cloudflareclient.com');
  });

  it('H2 节点识别 network: h2 与自定义端口', () => {
    const result = parseSubscriptionContent(YAML, 'test');
    const node = result.nodes.find((n) => n.name === 'WARP-H2');
    expect(node?.protocol).toBe('masque');
    expect(node?.masqueNetwork).toBe('h2');
    expect(node?.port).toBe(8443);
  });

  it('缺少 private-key/public-key 的 masque 节点被拒绝', () => {
    const bad = `proxies:
- name: BAD
  type: masque
  server: 1.2.3.4
  port: 443
`;
    const result = parseSubscriptionContent(bad, 'test');
    expect(result.nodes).toHaveLength(0);
    expect(result.errors[0]?.code).toBe('CONVERSION_FAILED');
  });

  it('Clash YAML 的 hysteria2 不再被白名单误杀（回归）', () => {
    const result = parseSubscriptionContent(YAML, 'test');
    expect(result.nodes.find((n) => n.name === 'HY2')?.protocol).toBe('hysteria2');
  });
});
