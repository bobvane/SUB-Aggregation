/**
 * 节点探测引擎 - 真实握手回归测试（v2.36）
 *
 * 回归背景：v2.32~v2.35 的 probeTcp 用 `new WebSocket("wss://host:port")` 当 TCP 连通性测试。
 * 节点端口不是 WebSocket 服务，永远握手失败 → 全量节点标记 dead、延迟恒 null、
 * 面板「延迟」列全是 `-`、评分恒 50（冷启动分）。probeHttp 更是在服务器本机 fetch Google，
 * 测的是服务器自己而不是节点。
 *
 * 本测试用真实监听端口证明：端口开着 → alive + 有延迟；端口关着 → dead。旧实现必挂。
 */
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { probeAllNodes, type HealthStorage } from '@/services/node-probe.service';
import type { Node } from '@/models/node';

function memStorage(): HealthStorage {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })),
  };
}

const makeNode = (id: string, port: number, tls = false): Node => ({
  id,
  name: id,
  protocol: 'vless',
  server: '127.0.0.1',
  port,
  tls,
  version: 0,
  metadata: { source: 'test', originalName: id, tags: [] },
});

/** 起一个真实监听端口，返回端口号 */
function listen(handler?: (sock: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer(handler ?? (() => { /* 只握手不响应 */ }));
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() });
    });
  });
}

/** 取一个当前没人监听的端口 */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); });

describe('节点探测引擎（真实 TCP/TLS 握手）', () => {
  it('端口可达 → alive 且有延迟；端口不可达 → dead 且延迟为 null', async () => {
    const open = await listen();
    cleanups.push(open.close);
    const closed = await closedPort();

    const { results, stats } = await probeAllNodes(
      [makeNode('up', open.port), makeNode('down', closed)],
      memStorage()
    );
    const up = results.find((r) => r.nodeId === 'up')!;
    const down = results.find((r) => r.nodeId === 'down')!;

    expect(up.status).toBe('alive');
    expect(up.tcpLatency).not.toBeNull();
    expect(up.tcpLatency!).toBeGreaterThanOrEqual(0);
    expect(up.tcpLatency!).toBeLessThan(2000);
    expect(up.error).toBeNull();

    expect(down.status).toBe('dead');
    expect(down.tcpLatency).toBeNull();
    expect(down.error).toMatch(/TCP/);

    expect(stats.total).toBe(2);
    expect(stats.alive).toBe(1);
    expect(stats.dead).toBe(1);
    expect(stats.avgLatency).not.toBeNull();
  });

  it('tls 节点握手失败 → dead；明文节点不做 TLS 握手 → alive', async () => {
    // 接受连接立刻断开：TLS 握手必失败
    const rude = await listen((sock) => sock.destroy());
    cleanups.push(rude.close);

    const { results } = await probeAllNodes(
      [makeNode('tls-broken', rude.port, true), makeNode('plain', rude.port, false)],
      memStorage()
    );
    const broken = results.find((r) => r.nodeId === 'tls-broken')!;
    const plain = results.find((r) => r.nodeId === 'plain')!;

    expect(broken.status).toBe('dead');
    expect(broken.error).toMatch(/TLS/);
    expect(broken.tcpLatency).not.toBeNull(); // TCP 是通的，坏在 TLS

    expect(plain.status).toBe('alive');
    expect(plain.tlsLatency).toBeNull();
  });

  it('健康记录写盘：latest 快照含 statusMachine，供列表页/配置过滤读取', async () => {
    const open = await listen();
    cleanups.push(open.close);
    const storage = memStorage();

    const { results } = await probeAllNodes([makeNode('up', open.port)], storage);
    const raw = await storage.get(`health:latest:${results[0].fingerprint}`);
    expect(raw).not.toBeNull();
    const latest = JSON.parse(raw!) as { status: string; statusMachine?: string; score: number };
    expect(latest.status).toBe('alive');
    expect(latest.statusMachine).toBe('active');
    expect(latest.score).toBeGreaterThan(0);
  });
});
