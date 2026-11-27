/**
 * WARP 实验页服务（独立模块）回归：
 * - MASQUE 设备两步注册（占位 WG → ECDSA/masque）
 * - H2/H3 节点生成与 mihomo YAML
 * - 端点解析、peer key 归一化、脱敏
 * - 独立 KV 读写/清除
 *
 * 该模块不依赖节点列表/输出/探测；测试也不导入那些模块。
 */
import { describe, it, expect } from 'vitest';
import type { FetchFn } from '@/engine/http-client';
import {
  WARP_LAB_DEFAULT_SNI,
  buildMasqueYaml,
  clearWarpLab,
  generateMasqueNodes,
  generateMasqueNodesFromItems,
  maskWarpLabAccount,
  normalizePeerKey,
  parseWarpEndpoint,
  readWarpLabAccount,
  readWarpLabNodes,
  registerMasqueDevice,
  saveWarpLabAccount,
  saveWarpLabNodes,
  type WarpLabAccount,
  type WarpLabStorage,
} from '@/services/warp-lab.service';

const account: WarpLabAccount = {
  id: 'dev-12345678',
  token: 'token-abc',
  privateKey: 'cHJpdmF0ZQ==',
  peerPublicKey: 'cGVlcg==',
  ipv4: '172.16.0.2',
  ipv6: 'fd01::2',
  registeredAt: 1_700_000_000_000,
};

const makeStorage = (): WarpLabStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
  };
};

describe('WARP MASQUE 设备注册', () => {
  it('两步注册：先 curve25519/占位，再 secp256r1/masque，并解析 peer key 与地址', async () => {
    const calls: Array<{ method?: string; body: Record<string, unknown> }> = [];
    const fetchFn: FetchFn = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method: init?.method, body });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'dev-12345678', token: 'token-abc' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 'dev-12345678',
        token: 'token-abc',
        config: {
          peers: [{ public_key: '-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----' }],
          interface: { addresses: { v4: '172.16.0.2', v6: 'fd01::2' } },
        },
      }), { status: 200 });
    };

    const acc = await registerMasqueDevice(fetchFn);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body.key_type).toBe('curve25519');
    expect(calls[0].body.tunnel_type).toBe('wireguard');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].body.key_type).toBe('secp256r1');
    expect(calls[1].body.tunnel_type).toBe('masque');

    expect(acc.id).toBe('dev-12345678');
    expect(acc.ipv4).toBe('172.16.0.2');
    expect(acc.ipv6).toBe('fd01::2');
    expect(acc.peerPublicKey).toBe('QUJD');
    expect(acc.privateKey.length).toBeGreaterThan(20);
    expect(acc.peerPublicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('API 非 2xx 时抛出可读错误', async () => {
    const fetchFn: FetchFn = async () => new Response('denied', { status: 403 });
    await expect(registerMasqueDevice(fetchFn)).rejects.toThrow(/403/);
  });
});

describe('MASQUE 节点生成', () => {
  it('H2 + H3 每端点各一个，H2 带 network: h2，H3 不带', () => {
    const nodes = generateMasqueNodes(account, {
      endpoints: ['162.159.198.1:443', '162.159.198.2:443'],
      sni: 'example.sni',
      h2: true,
      h3: true,
    });
    expect(nodes.map((n) => n.name)).toEqual([
      'WARP-H2-01', 'WARP-H2-02', 'WARP-H3-01', 'WARP-H3-02',
    ]);
    expect(nodes[0].transport).toBe('h2');
    expect(nodes[0].yaml).toContain('type: masque');
    expect(nodes[0].yaml).toContain('network: h2');
    expect(nodes[2].yaml).not.toContain('network: h2');
    expect(nodes[0].yaml).toContain('server: "162.159.198.1"');
    expect(nodes[0].yaml).toContain('sni: "example.sni"');
    expect(nodes[0].yaml).toContain('private-key: "cHJpdmF0ZQ=="');
    expect(nodes[0].yaml).toContain('public-key: "cGVlcg=="');
    expect(nodes[0].yaml).toContain('ip: "172.16.0.2"');
    expect(nodes[0].yaml).toContain('ipv6: "fd01::2"');
    expect(nodes[0].yaml).toContain('ip-stack:');
    expect(nodes[0].yaml).toContain('udp: true');
  });

  it('可只生成 H2；SNI 缺省用默认值；端点去重', () => {
    const nodes = generateMasqueNodes(account, {
      endpoints: ['162.159.198.1:443', '162.159.198.1:443'],
      h2: true,
      h3: false,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].transport).toBe('h2');
    expect(nodes[0].sni).toBe(WARP_LAB_DEFAULT_SNI);
  });

  it('H2/H3 都不选时抛错', () => {
    expect(() => generateMasqueNodes(account, { h2: false, h3: false })).toThrow(/H2|H3/);
  });

  it('buildMasqueYaml 不包含 network 时为 H3 形态', () => {
    const yaml = buildMasqueYaml(account, {
      name: 'WARP-H3-01', transport: 'h3', server: '162.159.198.1', port: 443, sni: 's.example',
    });
    expect(yaml).toContain('type: masque');
    expect(yaml).not.toContain('network:');
  });
});

describe('按已验证端点生成节点（v2.50.4）', () => {
  it('每个端点只生成它验证通过的传输，名称按传输分别编号', () => {
    const nodes = generateMasqueNodesFromItems(
      account,
      [
        { server: '162.159.198.1', port: 443, transport: 'h3' },
        { server: '162.159.198.2', port: 443, transport: 'h3' },
        { server: '162.159.198.3', port: 443, transport: 'h2' },
      ],
      's.example'
    );
    expect(nodes.map((n) => n.name)).toEqual(['WARP-H3-01', 'WARP-H3-02', 'WARP-H2-01']);
    expect(nodes[0].yaml).not.toContain('network: h2');
    expect(nodes[2].yaml).toContain('network: h2');
    expect(nodes[0].sni).toBe('s.example');
  });

  it('同端点同传输去重；非法端口抛错', () => {
    const nodes = generateMasqueNodesFromItems(account, [
      { server: '162.159.198.1', port: 443, transport: 'h3' },
      { server: '162.159.198.1', port: 443, transport: 'h3' },
    ]);
    expect(nodes).toHaveLength(1);
    expect(() =>
      generateMasqueNodesFromItems(account, [{ server: '1.2.3.4', port: 0, transport: 'h3' }])
    ).toThrow(/端口/);
  });
});

describe('端点与 peer key 解析', () => {
  it('host:port / 裸 host / [v6]:port', () => {
    expect(parseWarpEndpoint('162.159.198.1:443')).toEqual({ host: '162.159.198.1', port: 443 });
    expect(parseWarpEndpoint('162.159.198.1')).toEqual({ host: '162.159.198.1', port: 443 });
    expect(parseWarpEndpoint('[2606:4700::1]:8443')).toEqual({ host: '2606:4700::1', port: 8443 });
  });

  it('非法端口抛错', () => {
    expect(() => parseWarpEndpoint('1.2.3.4:0')).toThrow(/端口/);
    expect(() => parseWarpEndpoint('1.2.3.4:70000')).toThrow(/端口/);
  });

  it('PEM 归一化为 base64 DER', () => {
    expect(normalizePeerKey('-----BEGIN PUBLIC KEY-----\nQUJD\nREVG\n-----END PUBLIC KEY-----')).toBe('QUJDREVG');
    expect(normalizePeerKey('QUJD')).toBe('QUJD');
  });
});

describe('脱敏与独立存储', () => {
  it('账号脱敏不返回私钥/token', () => {
    const masked = maskWarpLabAccount(account) as Record<string, unknown>;
    expect(masked.id).toBe('****5678');
    expect(masked.ipv4).toBe('172.16.0.2');
    expect(masked.privateKey).toBeUndefined();
    expect(masked.token).toBeUndefined();
    expect(masked.peerPublicKey).toBeUndefined();
  });

  it('账号/节点独立读写与清除', async () => {
    const storage = makeStorage();
    await saveWarpLabAccount(storage, account);
    expect(await readWarpLabAccount(storage)).toEqual(account);

    const nodes = generateMasqueNodes(account, { endpoints: ['162.159.198.1:443'], h2: true, h3: true });
    await saveWarpLabNodes(storage, nodes);
    expect(await readWarpLabNodes(storage)).toEqual(nodes);

    await clearWarpLab(storage);
    expect(await readWarpLabAccount(storage)).toBeNull();
    expect(await readWarpLabNodes(storage)).toEqual([]);
    expect(storage.map.size).toBe(0);
  });
});
