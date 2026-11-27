/**
 * v2.50.5：MASQUE 节点写入 mihomo 配置。
 */
import { describe, it, expect } from 'vitest';
import { createNode } from '@/models/node';
import { nodeToMihomoProxy } from '@/generator/mihomo';

const base = {
  name: 'WARP-H3',
  protocol: 'masque' as const,
  server: '162.159.198.1',
  port: 443,
  sni: 'consumer-masque.cloudflareclient.com',
  masquePrivateKey: 'PRIV',
  masquePublicKey: 'PUB',
  masqueIp: '172.16.0.2',
  masqueIpv6: 'fd01::2',
  masqueNetwork: 'h3' as const,
  masqueUdp: true,
  masqueCongestionController: 'bbr',
  masqueIpStack: 'gvisor',
  masqueHandshakeTimeout: 5,
};

describe('nodeToMihomoProxy - MASQUE', () => {
  it('H3：不输出 network，字段完整', () => {
    const proxy = nodeToMihomoProxy(createNode({ ...base }));
    expect(proxy.type).toBe('masque');
    expect(proxy.network).toBeUndefined();
    expect(proxy.server).toBe('162.159.198.1');
    expect(proxy.port).toBe(443);
    expect(proxy.sni).toBe('consumer-masque.cloudflareclient.com');
    expect(proxy['private-key']).toBe('PRIV');
    expect(proxy['public-key']).toBe('PUB');
    expect(proxy.ip).toBe('172.16.0.2');
    expect(proxy.ipv6).toBe('fd01::2');
    expect(proxy.udp).toBe(true);
    expect(proxy['congestion-controller']).toBe('bbr');
    expect(proxy['ip-stack']).toEqual({ mode: 'gvisor' });
    expect(proxy['handshake-timeout']).toBe(5);
  });

  it('H2：输出 network: h2', () => {
    const proxy = nodeToMihomoProxy(createNode({ ...base, masqueNetwork: 'h2' }));
    expect(proxy.network).toBe('h2');
  });

  it('udp 缺省为 true', () => {
    const proxy = nodeToMihomoProxy(createNode({ ...base, masqueUdp: undefined }));
    expect(proxy.udp).toBe(true);
  });
});
