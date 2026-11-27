/**
 * v2.50.8：MASQUE 不参与 IP 归属地查询。
 * server 是 Cloudflare anycast 入口，不是出口，查了只会得到错误国家。
 */
import { describe, it, expect } from 'vitest';
import { createNode } from '@/models/node';
import { geoLookupServers } from '@/services/ip-geo.service';

describe('geoLookupServers', () => {
  it('排除 masque，保留其他协议并按 server 去重', () => {
    const nodes = [
      createNode({ name: 'v1', protocol: 'vless', server: 'a.example.com', port: 443 }),
      createNode({ name: 'm1', protocol: 'masque', server: '162.159.198.1', port: 443 }),
      createNode({ name: 'v2', protocol: 'vless', server: 'a.example.com', port: 8443 }),
      createNode({ name: 'h', protocol: 'hysteria2', server: 'hy.example.com', port: 443 }),
    ];
    expect(geoLookupServers(nodes)).toEqual(['a.example.com', 'hy.example.com']);
  });

  it('全是 masque 时返回空数组', () => {
    const nodes = [
      createNode({ name: 'm1', protocol: 'masque', server: '162.159.198.1', port: 443 }),
      createNode({ name: 'm2', protocol: 'masque', server: '162.159.199.1', port: 443 }),
    ];
    expect(geoLookupServers(nodes)).toEqual([]);
  });
});
