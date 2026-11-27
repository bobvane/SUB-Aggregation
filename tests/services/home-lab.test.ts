/**
 * 家宽实验服务（v2.50.9）：VPN Gate CSV 解析、住宅评分、拉取调度、端口连通。
 * 不触网：CSV / 情报接口都用假 fetch；TCP 只连本机临时端口。
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import type { FetchFn } from '@/engine/http-client';
import { MemoryKvAdapter } from '@/storage/kv';
import {
  HOME_LAB_INTEL_PREFIX,
  HOME_LAB_NODES_KEY,
  HOME_LAB_SETTINGS_KEY,
  classifyHomeLabNode,
  extractOpenVpnRemote,
  maybeFetchHomeLab,
  parseVpnGateCsv,
  readHomeLabNodes,
  readHomeLabSettings,
  refreshHomeLab,
  saveHomeLabSettings,
  testTcpReachable,
} from '@/services/home-lab.service';

const OVPN = `client
dev tun
proto tcp
remote 203.0.113.7 443
<ca>
-----BEGIN CERTIFICATE-----
fake
-----END CERTIFICATE-----
</ca>
`;

const CSV =
  '*vpn_servers\n' +
  '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64\n' +
  `vpn1.opengw.net,203.0.113.7,1000,50,1000000,"Korea, Republic of",KR,3,1,1,1,1,"Operator, Inc.",,${Buffer.from(OVPN).toString('base64')}\n`;

describe('VPN Gate CSV', () => {
  it('解析字段、引号内逗号与 OpenVPN remote', () => {
    const { nodes, skipped } = parseVpnGateCsv(CSV);
    expect(skipped).toBe(0);
    expect(nodes).toHaveLength(1);
    const n = nodes[0];
    expect(n.id).toBe('kr-203.0.113.7-443');
    expect(n.ip).toBe('203.0.113.7');
    expect(n.port).toBe(443);
    expect(n.proto).toBe('tcp');
    expect(n.countryShort).toBe('KR');
    expect(n.countryLong).toBe('Korea, Republic of');
    expect(n.operator).toBe('Operator, Inc.');
    expect(n.pingMs).toBe(50);
  });

  it('没有有效 remote 的行被跳过', () => {
    const bad = `*vpn_servers\n#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64\nvpn2.opengw.net,,,,,,,,,,,,,,\n`;
    const { nodes, skipped } = parseVpnGateCsv(bad);
    expect(nodes).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('extractOpenVpnRemote 识别 tcp/udp', () => {
    expect(extractOpenVpnRemote(OVPN)).toMatchObject({ ip: '203.0.113.7', port: 443, proto: 'tcp' });
    expect(extractOpenVpnRemote('client\nproto udp\nremote 198.51.100.9 1194\n')).toMatchObject({
      ip: '198.51.100.9',
      port: 1194,
      proto: 'udp',
    });
  });
});

describe('住宅评分', () => {
  it('hosting=true → datacenter', () => {
    const c = classifyHomeLabNode('vpn1', {
      source: 'ip-api',
      checkedAt: 1,
      hosting: true,
      isp: 'Some Hosting LLC',
    });
    expect(c.class).toBe('datacenter');
  });

  it('mobile=true → residential', () => {
    const c = classifyHomeLabNode('vpn1', {
      source: 'ip-api',
      checkedAt: 1,
      mobile: true,
      isp: 'Some Wireless',
    });
    expect(c.class).toBe('residential');
  });

  it('public-vpn-* 主机名 → datacenter', () => {
    const c = classifyHomeLabNode('public-vpn-184', {
      source: 'ip-api',
      checkedAt: 1,
      isp: 'Daiyuu Nobori',
    });
    expect(c.class).toBe('datacenter');
  });

  it('家宽 ISP → likely_residential', () => {
    const c = classifyHomeLabNode('vpn1', {
      source: 'ip-api',
      checkedAt: 1,
      isp: 'Korea Telecom',
      as: 'AS4766',
    });
    expect(c.class).toBe('likely_residential');
  });

  it('vpn* 志愿者主机名（非 public-vpn）→ likely_residential', () => {
    const c = classifyHomeLabNode('vpn123', {
      source: 'ip-api',
      checkedAt: 1,
      isp: 'Daiyuu Nobori',
    });
    expect(c.class).toBe('likely_residential');
  });

  it('没有信号 → unknown（不默认 residential）', () => {
    const c = classifyHomeLabNode('relay1', null);
    expect(c.class).toBe('unknown');
    expect(c.confidence).toBe(0);
  });
});

describe('拉取与调度', () => {
  const sourceFetch: FetchFn = async () => new Response(CSV, { status: 200 });
  const intelFetch: FetchFn = async (url) => {
    if (url.includes('ip-api.com/batch')) {
      return new Response(
        JSON.stringify([
          {
            query: '203.0.113.7',
            status: 'success',
            country: 'Japan',
            countryCode: 'JP',
            isp: 'Korea Telecom',
            as: 'AS4766',
            mobile: false,
            proxy: false,
            hosting: false,
          },
        ]),
        { status: 200 }
      );
    }
    if (url.includes('api.ipapi.is')) {
      return new Response(
        JSON.stringify({
          is_datacenter: false,
          is_vpn: false,
          is_proxy: false,
          company: { type: 'isp' },
          asn: { type: 'isp' },
          location: { country_code: 'JP' },
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 200 });
  };

  it('refreshHomeLab 保存节点与统计', async () => {
    const kv = new MemoryKvAdapter();
    const result = await refreshHomeLab(kv, sourceFetch, intelFetch);
    expect(result.parsed).toBe(1);
    expect(result.likelyResidential).toBe(1);
    const nodes = await readHomeLabNodes(kv);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].class).toBe('likely_residential');
    expect(nodes[0].intel?.source).toBe('both');
    const settings = await readHomeLabSettings(kv);
    expect(settings.lastFetchAt).toBeGreaterThan(0);
    expect(settings.lastError).toBeNull();
  });

  it('总开关关闭时 maybeFetchHomeLab 直接短路', async () => {
    const kv = new MemoryKvAdapter();
    const out = await maybeFetchHomeLab(kv, sourceFetch, intelFetch);
    expect(out).toBeNull();
    expect(await kv.get(HOME_LAB_NODES_KEY)).toBeNull();
  });

  it('启用后首次到点拉取，紧接着第二次不到点', async () => {
    const kv = new MemoryKvAdapter();
    await saveHomeLabSettings(kv, { enabled: true, intervalHours: 12 });
    const first = await maybeFetchHomeLab(kv, sourceFetch, intelFetch);
    expect(first?.parsed).toBe(1);
    const second = await maybeFetchHomeLab(kv, sourceFetch, intelFetch);
    expect(second).toBeNull();
    expect(await kv.get(HOME_LAB_SETTINGS_KEY)).toContain('"enabled":true');
  });

  it('情报缓存写入 home_lab:intel:*', async () => {
    const kv = new MemoryKvAdapter();
    await refreshHomeLab(kv, sourceFetch, intelFetch);
    const keys = await kv.list(HOME_LAB_INTEL_PREFIX);
    expect(keys.some((k) => k.key === `${HOME_LAB_INTEL_PREFIX}203.0.113.7`)).toBe(true);
  });
});

describe('端口连通测试', () => {
  it('本机监听端口可达', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const result = await testTcpReachable('127.0.0.1', port, 1000);
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).not.toBeNull();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('关闭后的端口不可达', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await testTcpReachable('127.0.0.1', port, 500);
    expect(result.reachable).toBe(false);
  });
});
