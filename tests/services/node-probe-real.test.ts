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
import { probeAllNodes, resetProbeDataIfEngineChanged, type HealthStorage } from '@/services/node-probe.service';
import { nodeFingerprint, type Node } from '@/models/node';

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

  it('引擎 3→4 升级不再清理历史：窗口外但在 TTL 内的记录保留，不参与窗口内评分', async () => {
    const open = await listen();
    cleanups.push(open.close);
    const storage = memStorage();
    const node = makeNode('up', open.port);
    const fp = nodeFingerprint(node);

    // 模拟旧引擎留下的数据。两组时间戳，用途不同：
    //  A 组（窗口外、TTL 内）：**2.5 / 3 / 3.5 天前** —— 应被**保留**，但不参与 24h 窗口评分。
    //     用来证明「引擎升级不会删历史」，且不会与「TTL 正常清理」混淆。
    //     ⚠️ 时间余量说明：原实现用 `now0 - 1 * DAY`，恰好等于 24h 窗口长度
    //     （calculateScore 的窗口判定是 `now - ts <= windowMs`）。当评分时刻的
    //     `Date.now()` 与此处 `now0` 落在同一毫秒时，该记录会**落入窗口**使 N=1，
    //     评分从 50 变为 27（本用例在 Linux CI 上实际失败过一次）。
    //     现取最小 2.5 天（余量 12 小时，远大于毫秒级执行时差），既稳定超窗又稳在 TTL 内。
    //  B 组（真正超 TTL）：40 天前 —— 应被 cleanupOldHistory **正常清理**。
    //     用来证明 TTL 行为未被破坏（不是靠禁掉清理来让测试通过）。
    const now0 = Date.now();
    const DAY = 86_400_000;
    const inTtlButOutOfWindow = [now0 - 3.5 * DAY, now0 - 3 * DAY, now0 - 2.5 * DAY];
    for (const t of inTtlButOutOfWindow) {
      await storage.put(`health:hist:${fp}:${t}`, JSON.stringify({
        fingerprint: fp, status: 'dead', tcpLatency: null, tlsLatency: null, timestamp: t, score: 0,
      }));
    }
    const beyondTtl = [now0 - 40 * DAY, now0 - 41 * DAY];
    for (const t of beyondTtl) {
      await storage.put(`health:hist:${fp}:${t}`, JSON.stringify({
        fingerprint: fp, status: 'dead', tcpLatency: null, tlsLatency: null, timestamp: t, score: 0,
      }));
    }
    await storage.put(`health:latest:${fp}`, JSON.stringify({
      fingerprint: fp, status: 'dead', statusMachine: 'disabled', score: 0,
      tcpLatency: null, tlsLatency: null, timestamp: now0 - DAY,
    }));

    const { results } = await probeAllNodes([node], storage);

    expect(results[0].status).toBe('alive');
    // 窗口外记录不参与评分：N=0 → 非 TLS 可用率/延迟/稳定性各 0.5 → 50
    expect(results[0].score).toBe(50);

    // 阶段 2 起**引擎升级不再删历史**：A 组（窗口外但 TTL 内）全部保留
    for (const t of inTtlButOutOfWindow) {
      expect(await storage.get(`health:hist:${fp}:${t}`)).not.toBeNull();
    }
    // B 组（真正超过 30 天 TTL）仍被正常清理 —— TTL 行为未被破坏
    for (const t of beyondTtl) {
      expect(await storage.get(`health:hist:${fp}:${t}`)).toBeNull();
    }

    expect(await storage.get('probe:engine_version')).toBe('4');
    expect(await storage.get('probe:score_version')).toBe('4');
    expect(await storage.get('probe:schema_version')).toBe('1');

    // latest 被本轮结果覆盖：不再带着 disabled 把节点踢出配置
    const latest = JSON.parse((await storage.get(`health:latest:${fp}`))!) as { status: string; statusMachine: string };
    expect(latest.status).toBe('alive');
    // 状态机读取**全部保留历史**（evaluateStateMachine 不按时间窗口过滤）：
    // 最新一轮 alive，其前一条为 dead → 连续失败 1 次 → suspect
    // （既有状态机语义：「成功 2 次 → active」，本轮为首次成功）
    expect(latest.statusMachine).toBe('suspect');
  });

  it('版本键同步幂等：首次返回 true，重复调用返回 false', async () => {
    const storage = memStorage();
    expect(await resetProbeDataIfEngineChanged(storage)).toBe(true);
    expect(await resetProbeDataIfEngineChanged(storage)).toBe(false);
  });
});
