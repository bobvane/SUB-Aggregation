/**
 * 端到端回归：多条 VLESS 链接（Reality + WS）→ 解析 → Mihomo YAML。
 *
 * 线上现象：用户只看到 CA/WS 节点，怀疑第二条 Reality 链接被前一条污染。
 * 这里按 server 逐个定位 proxy，验证字段隔离、REALITY 新字段映射与名称唯一性。
 * 所有链接均为合成数据，不含真实凭据。
 */
import { describe, it, expect } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { parseSubscriptionContent } from '@/parser';
import { generateMihomoConfig } from '@/generator/mihomo';

const REALITY_US =
  'vless://00000000-0000-4000-8000-000000000001@us1.example.com:443' +
  '?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=TEST_PUBLIC_KEY_US&security=reality' +
  '&sid=0e2cab&sni=us-target.example.com&spx=%2F9d046d060c06028' +
  '&support-x25519mlkem768=true&type=tcp#US-1%40example.com';

const REALITY_MY =
  'vless://00000000-0000-4000-8000-000000000002@my1.example.com:443' +
  '?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=TEST_PUBLIC_KEY_MY&security=reality' +
  '&sid=3f0b&sni=my-target.example.com&spx=%2F31e971e5e7c8680' +
  '&support-x25519mlkem768=true&type=tcp#MY-1%40example.com';

const WS =
  'vless://00000000-0000-4000-8000-000000000003@ws.example.com:443' +
  '?security=tls&type=ws&host=ws.example.com&fp=chrome&sni=ws.example.com' +
  '&path=%2F%3Fed%3D2560&encryption=none#WS-1';

const CONTENT = [REALITY_US, REALITY_MY, WS].join('\n');

interface Proxy {
  name: string;
  type: string;
  server: string;
  port: number;
  uuid?: string;
  flow?: string;
  servername?: string;
  network?: string;
  'ws-opts'?: { path?: string; headers?: Record<string, string> };
  'reality-opts'?: Record<string, unknown>;
}

describe('VLESS Reality → Mihomo 输出字段隔离', () => {
  it('每条链接生成独立 proxy，字段不被其他节点污染', async () => {
    const parsed = parseSubscriptionContent(CONTENT, 'test');
    expect(parsed.success).toBe(3);
    const yaml = await generateMihomoConfig(parsed.nodes);
    const doc = yamlParse(yaml) as { proxies: Proxy[]; 'proxy-groups': Array<Record<string, unknown>> };

    expect(doc.proxies).toHaveLength(3);

    const us = doc.proxies.find((p) => p.server === 'us1.example.com');
    const my = doc.proxies.find((p) => p.server === 'my1.example.com');
    const ws = doc.proxies.find((p) => p.server === 'ws.example.com');
    expect(us && my && ws).toBeTruthy();

    expect(us).toMatchObject({
      type: 'vless',
      port: 443,
      uuid: '00000000-0000-4000-8000-000000000001',
      flow: 'xtls-rprx-vision',
      servername: 'us-target.example.com',
    });
    expect(my).toMatchObject({
      type: 'vless',
      uuid: '00000000-0000-4000-8000-000000000002',
      servername: 'my-target.example.com',
    });

    // Reality 参数只出现在各自节点
    expect(us!['reality-opts']).toMatchObject({
      'public-key': 'TEST_PUBLIC_KEY_US',
      'short-id': '0e2cab',
    });
    expect(my!['reality-opts']).toMatchObject({
      'public-key': 'TEST_PUBLIC_KEY_MY',
      'short-id': '3f0b',
    });

    // TCP 不输出 network；WS 节点保留自己的 ws-opts
    expect(us!.network).toBeUndefined();
    expect(my!.network).toBeUndefined();
    expect(ws!.network).toBe('ws');
    expect(ws!['ws-opts']).toMatchObject({
      path: '/?ed=2560',
      headers: { Host: 'ws.example.com' },
    });
    expect(ws!['reality-opts']).toBeUndefined();
  });

  it('Reality 输出 support-x25519mlkem768=true，且不输出 spx', async () => {
    const parsed = parseSubscriptionContent(CONTENT, 'test');
    const yaml = await generateMihomoConfig(parsed.nodes);
    const doc = yamlParse(yaml) as { proxies: Proxy[] };

    for (const server of ['us1.example.com', 'my1.example.com']) {
      const proxy = doc.proxies.find((p) => p.server === server)!;
      const reality = proxy['reality-opts']!;
      expect(reality['support-x25519mlkem768']).toBe(true);
      expect(reality.spx).toBeUndefined();
    }
  });

  it('节点名唯一，策略组引用的节点都存在', async () => {
    const parsed = parseSubscriptionContent(CONTENT, 'test');
    const yaml = await generateMihomoConfig(parsed.nodes);
    const doc = yamlParse(yaml) as {
      proxies: Proxy[];
      'proxy-groups': Array<{ name: string; proxies?: unknown[] }>;
    };

    const names = doc.proxies.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);

    const groupNames = new Set(doc['proxy-groups'].map((g) => g.name));
    const builtins = new Set(['DIRECT', 'REJECT', 'PASS', 'REJECT-DROP', 'COMPATIBLE']);
    for (const group of doc['proxy-groups']) {
      for (const ref of group.proxies ?? []) {
        if (typeof ref !== 'string') continue;
        if (builtins.has(ref) || groupNames.has(ref)) continue;
        expect(names).toContain(ref);
      }
    }
  });

  it('Clash YAML 的 servername 与 REALITY 扩展字段可进入同一生成链', async () => {
    const yamlSub = `proxies:
- name: YAML-REALITY
  type: vless
  server: yaml.example.com
  port: 443
  uuid: 00000000-0000-4000-8000-000000000004
  tls: true
  flow: xtls-rprx-vision
  servername: yaml-target.example.com
  reality-opts:
    public-key: TEST_PUBLIC_KEY_YAML
    short-id: abcd
    support-x25519mlkem768: true
`;
    const parsed = parseSubscriptionContent(yamlSub, 'test');
    const output = await generateMihomoConfig(parsed.nodes);
    const doc = yamlParse(output) as { proxies: Proxy[] };
    const proxy = doc.proxies.find((p) => p.server === 'yaml.example.com')!;
    expect(proxy.servername).toBe('yaml-target.example.com');
    expect(proxy['reality-opts']).toMatchObject({
      'public-key': 'TEST_PUBLIC_KEY_YAML',
      'short-id': 'abcd',
      'support-x25519mlkem768': true,
    });
  });
});
