/**
 * P0-2 + P1（阶段 1）：状态机严格验证（三轮独立失败确认 / 成功重置 / 引擎升级首轮保护 /
 *        UDP unknown 不累计 / 持久化防重复计数 / 系统剔除只认状态机 disabled）
 *
 * 架构依据（src/services/node-probe.service.ts）：
 * - evaluateStateMachine(:335)：历史按 timestamp 降序，连续非 alive ≥3 → disabled；
 *   ≥1 → suspect；连续 alive ≥2 → active。
 * - doProbeAllNodes(:451)：每轮追加一条 health:hist:{fp}:{ts}（ts=Date.now），
 *   unknown 状态 continue 不写历史/状态机(:472)。
 * - 状态由 KV 历史重算（非内存计数器），进程重启不重复计数。
 * - resetProbeDataIfEngineChanged：阶段 2 起**只同步版本号、不删除任何健康数据**。
 *   升级引擎 3→4 后历史保留，连续失败计数**跨版本延续**（这是有意的可用性保护变更：
 *   升级不会让已确认失效（statusMachine=disabled）的节点重新进入生成的配置）。
 *
 * 系统剔除（src/services/config.service.ts getDroppedNodes，P1 修复③ 后）：
 * 仅保留状态机确认失效：statusMachine==='disabled'（连续失败 ≥3 轮）才剔除。
 * 慢节点（alive 但握手延迟持续超阈值）不再仅因延迟被剔除 —— TCP/TLS 握手延迟
 * ≠ 代理实际转发延迟，健康统计与排序展示仍可使用延迟数据。
 */
import { describe, it, expect } from 'vitest';
import { MemoryKvAdapter, createRepositories } from '@/storage/kv';
import { createConfigService } from '@/services/config.service';
import { probeAllNodes, nodeFingerprint, evaluateStateMachine } from '@/services/node-probe.service';
import { createNode, type Node } from '@/models/node';

/** 保证每轮探测 timestamp 唯一（ms 级），使历史条目可区分 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 不可达节点（127.0.0.1:1 无监听 → TCP 探测 3 次全败 → dead） */
const deadNode = (): Node =>
  createNode({
    id: 'n-dead',
    name: 'DeadNode',
    protocol: 'vless',
    server: '127.0.0.1',
    port: 1,
    tls: false,
    metadata: { source: 'test', originalName: 'DeadNode', tags: [] },
  });

describe('P0-2 状态机确认（三轮独立失败 / 成功重置 / 持久化）', () => {
  it('连续三轮独立失败 → statusMachine=disabled → 进入 getDroppedNodes', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    for (let i = 0; i < 3; i++) {
      const { results } = await probeAllNodes([node], kv, 24);
      expect(results[0].status).toBe('dead');
      await sleep(5); // 保证下轮 timestamp 不同
    }

    const latestRaw = await kv.get(`health:latest:${fp}`);
    expect(latestRaw).not.toBeNull();
    const latest = JSON.parse(latestRaw!);
    expect(latest.statusMachine).toBe('disabled');

    // 双规则之 ①：statusMachine=disabled → 剔除
    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);

    // 历史恰好 3 条（每轮 1 条，无重复计数）
    const hist = await kv.list(`health:hist:${fp}:`);
    expect(hist.length).toBe(3);
  });

  it('失败两轮 + 成功一轮 + 再失败两轮 → 连续被成功打断 → 第4轮 dead 仍为 suspect → 不剔除', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    await probeAllNodes([node], kv, 24);          // 第1轮 dead（连续 1）
    await sleep(5);
    await probeAllNodes([node], kv, 24);          // 第2轮 dead（连续 2 → suspect）
    await sleep(5);

    // 模拟节点恢复：写入一条 alive 历史（等价于一轮成功探测的落库形态）
    // 架构层面：状态机按指纹计历史，成功条目打断连续失败计数
    await kv.put(
      `health:hist:${fp}:${Date.now()}`,
      JSON.stringify({
        nodeId: node.id, fingerprint: fp, timestamp: Date.now(),
        tcpLatency: 1, tlsLatency: null, httpLatency: null,
        status: 'alive', tlsApplicable: false, error: null, score: 90,
      }),
    );
    await sleep(5);
    await probeAllNodes([node], kv, 24);          // 第3轮 dead（新的连续 1 → suspect）
    await sleep(5);
    await probeAllNodes([node], kv, 24);          // 第4轮 dead（连续 2 → 仍 suspect，未达 3）

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`)) ?? '');
    expect(latest.statusMachine).toBe('suspect'); // 连续 2 次失败，被 alive 打断后重新累计，未达 3 轮

    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).not.toContain(fp);
  });

  it('失败两轮 + 成功 + 再失败两轮 + 第5轮失败 → 重新累计到 3 轮 → disabled → 剔除', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    await probeAllNodes([node], kv, 24);
    await sleep(5);
    await probeAllNodes([node], kv, 24);
    await sleep(5);
    await kv.put(
      `health:hist:${fp}:${Date.now()}`,
      JSON.stringify({
        nodeId: node.id, fingerprint: fp, timestamp: Date.now(),
        tcpLatency: 1, tlsLatency: null, httpLatency: null,
        status: 'alive', tlsApplicable: false, error: null, score: 90,
      }),
    );
    await sleep(5);
    await probeAllNodes([node], kv, 24); // 第3轮 dead（新的连续 1）
    await sleep(5);
    await probeAllNodes([node], kv, 24); // 第4轮 dead（连续 2）
    await sleep(5);
    await probeAllNodes([node], kv, 24); // 第5轮 dead（连续 3 → disabled）

    const latest = JSON.parse((await kv.get(`health:latest:${fp}`)) ?? '');
    expect(latest.statusMachine).toBe('disabled');

    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('引擎 3→4 保留历史：连续失败计数跨版本延续 → disabled → 剔除（有意的可用性保护变更）', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    // 模拟旧引擎（版本 3）留下的 3 条 dead 历史 + 已被判熔断的 latest。
    // 时间戳取「测试执行时刻前 3/2/1 天」：
    //  - 在 HEALTH_HISTORY_TTL_MS（30 天）之内 → 不会被 cleanupOldHistory 清理；
    //  - 在 24h 评分窗口之外 → 不参与 availability 计算；
    //  - 但 evaluateStateMachine 不按窗口过滤 → 连续失败计数仍然读到它们。
    // 这样测试失败时能区分「被引擎升级删除」与「被 TTL 正常清理」。
    const now0 = Date.now();
    const old = [now0 - 3 * 86_400_000, now0 - 2 * 86_400_000, now0 - 86_400_000];
    for (const ts of old) {
      await kv.put(
        `health:hist:${fp}:${ts}`,
        JSON.stringify({
          nodeId: node.id, fingerprint: fp, timestamp: ts,
          tcpLatency: null, tlsLatency: null, httpLatency: null,
          status: 'dead', tlsApplicable: false, error: 'old', score: 0,
        }),
      );
    }
    await kv.put('probe:engine_version', '3');
    await kv.put(
      `health:latest:${fp}`,
      JSON.stringify({
        nodeId: node.id, fingerprint: fp, timestamp: old[2],
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
      }),
    );

    // 升级到评分代次 4：**不清空历史**，只补写三个版本键
    const { results } = await probeAllNodes([node], kv, 24);
    expect(results[0].status).toBe('dead');
    expect(await kv.get('probe:engine_version')).toBe('4');
    expect(await kv.get('probe:score_version')).toBe('4');
    expect(await kv.get('probe:schema_version')).toBe('1');

    // 旧 3 条 + 本轮 1 条 = 4 条历史全部保留（若被无差别清空，这里会是 1）
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(4);

    // 连续失败计数跨版本延续：3 条旧 dead + 本轮 dead = 连续 4 次 → disabled
    // （旧实现会清空历史、只剩 1 条 → suspect 且不剔除；阶段 2 明确改为延续）
    const latest = JSON.parse((await kv.get(`health:latest:${fp}`)) ?? '');
    expect(latest.statusMachine).toBe('disabled');

    const svc = createConfigService(createRepositories(kv), kv);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('UDP 节点 unknown 不累计失败、不写历史、不进入 dropped', async () => {
    const kv = new MemoryKvAdapter();
    const udp = createNode({
      id: 'n-h2', name: 'H2', protocol: 'hysteria2',
      server: '127.0.0.1', port: 443, tls: true,
      metadata: { source: 'test', originalName: 'H2', tags: [] },
    });
    const fp = nodeFingerprint(udp);

    for (let i = 0; i < 3; i++) {
      const { results } = await probeAllNodes([udp], kv, 24);
      expect(results[0].status).toBe('unknown');
      await sleep(5);
    }

    // 3 轮 unknown 后：不写健康历史、不进 dropped
    expect((await kv.list(`health:hist:${fp}:`)).length).toBe(0);
    expect(await kv.get(`health:latest:${fp}`)).toBeNull();

    const svc = createConfigService(createRepositories(kv), kv);
    const dropped = await svc.getDroppedNodes();
    expect(dropped).not.toContain(fp);
  });

  it('持久化：重启后从 KV 历史重算，不重复计数、不漏计', async () => {
    const kv = new MemoryKvAdapter();
    const node = deadNode();
    const fp = nodeFingerprint(node);

    // 进程 1：跑 2 轮（suspect）
    await probeAllNodes([node], kv, 24);
    await sleep(5);
    await probeAllNodes([node], kv, 24);
    const m1 = JSON.parse((await kv.get(`health:latest:${fp}`)) ?? '');
    expect(m1.statusMachine).toBe('suspect');

    // 模拟进程重启：把 KV 内容 dump 到新的 MemoryKvAdapter
    const dump = new MemoryKvAdapter();
    for (const { key } of await kv.list('')) {
      const v = await kv.get(key);
      if (v !== null) await dump.put(key, v);
    }

    // 进程 2：同一状态源，再跑 1 轮 → disabled（跨进程累计 3 次独立失败）
    await probeAllNodes([node], dump, 24);
    const m2 = JSON.parse((await dump.get(`health:latest:${fp}`)) ?? '');
    expect(m2.statusMachine).toBe('disabled');

    // 历史共 3 条（没有因重启重复计数）
    expect((await dump.list(`health:hist:${fp}:`)).length).toBe(3);

    const svc = createConfigService(createRepositories(dump), dump);
    expect(await svc.getDroppedNodes()).toContain(fp);
  });

  it('P1 修复③：系统剔除只认状态机 disabled；慢节点（alive 但持续慢）不再仅因延迟被剔除；suspect 死节点保留', async () => {
    const kv = new MemoryKvAdapter();
    const svc = createConfigService(createRepositories(kv), kv);

    // 规则①：状态机 disabled（即使 latency 为 null 也剔除）
    const deadDisabled = '10.0.0.1:443:vless';
    await kv.put(
      `health:latest:${deadDisabled}`,
      JSON.stringify({
        nodeId: 'x1', fingerprint: deadDisabled, timestamp: 2_000_000_000_000,
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
      }),
    );

    // P1 修复③：alive 但持续慢（latest 2500>2000，历史 3 条 2 条超 2000）→ 不再剔除（延迟 ≠ 失效）
    const slowFp = '10.0.0.2:443:vmess';
    await kv.put(
      `health:latest:${slowFp}`,
      JSON.stringify({
        nodeId: 'x2', fingerprint: slowFp, timestamp: 2_000_000_000_000,
        tcpLatency: 2500, tlsLatency: null, httpLatency: null,
        status: 'alive', tlsApplicable: false, error: null, score: 40, statusMachine: 'active',
      }),
    );
    const ts = [1_990_000_000_000, 1_990_000_300_000, 1_990_000_600_000];
    for (const t of ts) {
      await kv.put(
        `health:hist:${slowFp}:${t}`,
        JSON.stringify({
          nodeId: 'x2', fingerprint: slowFp, timestamp: t,
          tcpLatency: 2500, tlsLatency: null, httpLatency: null,
          status: 'alive', tlsApplicable: false, error: null, score: 40,
        }),
      );
    }

    // 边界：suspect 死节点（连续 1-2 轮 dead，未确认）→ 不剔除 → 保留
    const suspectDead = '10.0.0.3:443:trojan';
    await kv.put(
      `health:latest:${suspectDead}`,
      JSON.stringify({
        nodeId: 'x3', fingerprint: suspectDead, timestamp: 2_000_000_000_000,
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'suspect',
      }),
    );

    const dropped = await svc.getDroppedNodes();
    expect(dropped).toContain(deadDisabled);   // 规则① 状态机确认失效 → 剔除
    expect(dropped).not.toContain(slowFp);      // P1 修复③：慢节点不再仅因延迟剔除
    expect(dropped).not.toContain(suspectDead); // 未确认失效 → 保留
  });

  it('getNodes 过滤链：锁定豁免 > 用户禁用 > 系统剔除 > removed', async () => {
    const kv = new MemoryKvAdapter();
    const repos = createRepositories(kv);
    const base = (id: string, name: string, extra: Partial<Node> = {}): Node =>
      createNode({
        id, name, protocol: 'vless', server: `10.9.0.${id.slice(-1)}`, port: 443,
        metadata: { source: 'test', originalName: name, tags: [] }, ...extra,
      } as Partial<Node> & { name: string });

    const locked = base('n-locked', 'Locked');
    const userDisabled = base('n-disabled', 'UserDisabled');
    const systemDropped = base('n-dropped', 'SystemDropped');
    const removed = base('n-removed', 'Removed', { status: 'removed', removed_at: Date.now() });

    await repos.nodes.setBySubscription('sub1', [locked, userDisabled, systemDropped, removed]);
    const svc = createConfigService(repos, kv);
    // 锁定/禁用走 settings 仓储（与生产路径一致）
    await svc.setLockedNodes([nodeFingerprint(locked)]);
    await svc.setDisabledNodes([nodeFingerprint(userDisabled)]);
    // 系统剔除：状态机 disabled（确认失效）
    await kv.put(
      `health:latest:${nodeFingerprint(systemDropped)}`,
      JSON.stringify({
        nodeId: systemDropped.id, fingerprint: nodeFingerprint(systemDropped), timestamp: Date.now(),
        tcpLatency: null, tlsLatency: null, httpLatency: null,
        status: 'dead', tlsApplicable: false, error: null, score: 0, statusMachine: 'disabled',
      }),
    );

    const nodes = await svc.getNodes();
    const names = nodes.map((n) => n.name);
    expect(names).toContain('Locked');           // 锁定豁免：即使在系统剔除/禁用名单也保留
    expect(names).not.toContain('UserDisabled'); // 用户主动禁用 → 过滤
    expect(names).not.toContain('SystemDropped'); // 状态机确认失效 → 剔除
    expect(names).not.toContain('Removed');      // 订阅更新消失 → tombstone 过滤
  });
});

/** P0-2：evaluateStateMachine 纯函数直测（熔断口径精确性） */
describe('evaluateStateMachine 熔断口径（纯函数）', () => {
  // 固定时间基准（确定性，不依赖系统当前时间）。
  // 历史时间戳按「相对 THIS_NOW 的分钟偏移」生成，保证：
  //   · 全部为有效毫秒时间戳（有限数且 > 0）
  //   · 全部早于 THIS_NOW（不会触发未来容差过滤）
  const THIS_NOW = 1_700_000_000_000;
  const MIN = 60_000;
  /** rows 的数字表示「距 THIS_NOW 的分钟数」，越大越早 */
  const H = (rows: Array<[number, string]>) =>
    rows.map(([minutesAgo, status]) => ({ timestamp: THIS_NOW - minutesAgo * MIN, status }));
  const SM = (rows: Array<[number, string]>) => evaluateStateMachine(H(rows), THIS_NOW).status;

  it('连续 3 次失败 → disabled（第 3 次计入当轮）', () => {
    expect(SM([[3, 'dead'], [2, 'dead'], [1, 'dead']])).toBe('disabled');
  });

  it('连续 2 次失败 → suspect（未达 3 轮确认）', () => {
    expect(SM([[2, 'dead'], [1, 'dead']])).toBe('suspect');
  });

  it('连续 4 次失败 → disabled（超出 3 轮仍确认）', () => {
    expect(SM([[4, 'dead'], [3, 'dead'], [2, 'dead'], [1, 'dead']])).toBe('disabled');
  });

  it('alive 打断：dead,dead,alive,dead → 连续 1 → suspect', () => {
    // 由旧到新：dead(4) dead(3) alive(2) dead(1) → 降序后 dead(1),alive(2),dead(3),dead(4)
    expect(SM([[4, 'dead'], [3, 'dead'], [2, 'alive'], [1, 'dead']])).toBe('suspect');
  });

  it('alive 打断后重新累计：dead,alive,dead,dead,dead → 连续 3 → disabled', () => {
    expect(SM([[5, 'dead'], [4, 'alive'], [3, 'dead'], [2, 'dead'], [1, 'dead']])).toBe('disabled');
  });

  it('连续 2 次 alive → active', () => {
    expect(SM([[2, 'alive'], [1, 'alive']])).toBe('active');
  });

  it('仅 1 次 alive → 默认 active（最新为 alive）', () => {
    expect(SM([[1, 'alive']])).toBe('active');
  });

  it('仅 1 次 dead → 默认 suspect（最新为非 alive）', () => {
    expect(SM([[1, 'dead']])).toBe('suspect');
  });

  it('无历史 → 默认 active（首轮保护，不会立即剔除）', () => {
    expect(evaluateStateMachine([], THIS_NOW).status).toBe('active');
  });

  it('timeout / error 与 dead 同等计入连续失败', () => {
    expect(SM([[3, 'timeout'], [2, 'error'], [1, 'dead']])).toBe('disabled');
  });
});
