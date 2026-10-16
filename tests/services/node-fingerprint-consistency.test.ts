/**
 * P1（阶段 C2）：节点指纹规范一致性。
 *
 * 产品语义（docs/02_DATA_MODEL.md:78）：
 *   「节点指纹：server:port:protocol（小写），由 nodeFingerprint() 生成。
 *     禁用/锁定状态按指纹持久化 —— 重抓订阅后不丢失。」
 *
 * 本测试固定以下事实，防止指纹规范在去重、健康关联、锁定、剔除之间漂移：
 *   1. `deduplicateNodes()` 的键与 `nodeFingerprint()` 的输出必须同构
 *      （同为小写归一），否则去重合并后健康/锁定/剔除全部失配。
 *   2. `nodeFingerprint()` 必须幂等：对已归一化的输入再归一化不改变结果。
 *   3. 健康键（health:latest / health:hist）、locked_nodes、disabled_nodes
 *      三处必须使用同一指纹口径。
 *   4. 最终配置不得因大小写差异产生重复节点或遗漏节点。
 */
import { describe, it, expect } from 'vitest';
import { nodeFingerprint } from '@/models/node';
import { deduplicateNodes } from '@/parser';
import { nodeFingerprint as probeFingerprint } from '@/services/node-probe.service';
import { KV_KEYS } from '@/models/config';
import { createNode, type Node } from '@/models/node';

const mk = (server: string, port = 443, protocol = 'vless', name = 'N'): Node =>
  createNode({
    id: `n-${server}-${port}`,
    name,
    protocol: protocol as Node['protocol'],
    server,
    port,
    metadata: { source: 'test', originalName: name, tags: [] },
  });

describe('P1 指纹规范：去重键与指纹必须同构', () => {
  it('同一 server 仅大小写不同 → 去重合并为 1 条', () => {
    const upper = mk('HK.Example.COM', 443, 'vless', 'Upper');
    const lower = mk('hk.example.com', 443, 'vless', 'Lower');
    const out = deduplicateNodes([upper, lower]);
    expect(out).toHaveLength(1);
  });

  it('去重保留的节点，其指纹必须能被健康数据检索到（大小写不敏感）', () => {
    const upper = mk('HK.Example.COM', 443, 'vless', 'Upper');
    const lower = mk('hk.example.com', 443, 'vless', 'Lower');
    // 订阅顺序：大写在前；去重保留大写节点
    const kept = deduplicateNodes([upper, lower])[0];

    // 模拟生产：探测写入用 probe 侧指纹；API/配置层用 models 侧指纹
    const probeKey = probeFingerprint(kept);
    const modelKey = nodeFingerprint(kept);
    const healthKey = KV_KEYS.healthLatest(probeKey);

    // 健康写入与读取必须命中同一个键
    expect(healthKey).toBe(KV_KEYS.healthLatest(modelKey));
  });

  it('server 仅大小写不同的两个节点，探测指纹与 API 指纹必须一致', () => {
    const upper = mk('HK.Example.COM');
    const lower = mk('hk.example.com');
    // 探测侧与模型侧必须给出相同指纹（否则 health 关联断裂）
    expect(probeFingerprint(upper)).toBe(nodeFingerprint(upper));
    expect(probeFingerprint(lower)).toBe(nodeFingerprint(lower));
    // 且大小写不同的两个节点指纹必须相同（去重才能与健康/锁定对齐）
    expect(probeFingerprint(upper)).toBe(probeFingerprint(lower));
  });
});

describe('P1 指纹规范：锁定 / 禁用 / 剔除按同一口径关联', () => {
  it('锁定大写 server 的节点后，保留的小写节点也应命中锁定集合', async () => {
    const upper = mk('HK.Example.COM', 443, 'vless', 'Upper');
    const lower = mk('hk.example.com', 443, 'vless', 'Lower');
    const kept = deduplicateNodes([upper, lower])[0];

    // 用户看到的可能是另一条订阅里的小写节点 → 锁定它
    const lockedSet = new Set([nodeFingerprint(lower)]);
    // 保留节点的指纹必须同样命中（否则锁定失效）
    expect(lockedSet.has(nodeFingerprint(kept))).toBe(true);
  });

  it('状态机 disabled 的指纹必须能剔除保留的节点', async () => {
    const upper = mk('HK.Example.COM', 443, 'vless', 'Upper');
    const lower = mk('hk.example.com', 443, 'vless', 'Lower');
    const kept = deduplicateNodes([upper, lower])[0];

    // 探测写入用 probe 指纹（历史上是原始大小写）
    const droppedFp = probeFingerprint(lower);
    // getDroppedNodes 用 health:latest 的 fingerprint 字段
    expect(droppedFp).toBe(nodeFingerprint(kept));
  });

  it('nodeFingerprint 幂等：对已归一化输入重复归一化不改变结果', () => {
    const n = mk('hk.example.com');
    const once = nodeFingerprint(n);
    const twice = nodeFingerprint({ ...n, server: once.split(':')[0] });
    expect(twice).toBe(once);
  });

  it('端口与协议参与指纹，且同样归一', () => {
    const a = mk('hk.example.com', 443, 'VLESS', 'A');
    const b = mk('HK.EXAMPLE.COM', 443, 'vless', 'B');
    expect(nodeFingerprint(a)).toBe(nodeFingerprint(b));
  });
});

describe('P1 指纹规范：最终配置不重复不遗漏', () => {
  it('仅大小写不同的重复订阅条目 → 最终 proxies 只出现 1 个该节点', () => {
    const upper = mk('HK.Example.COM', 443, 'vless', 'Dup');
    const lower = mk('hk.example.com', 443, 'vless', 'Dup');
    const unique = deduplicateNodes([upper, lower]);

    // makeUniqueNames 之后的节点集合仍为 1
    expect(unique).toHaveLength(1);
    // 指纹唯一
    const fps = new Set(unique.map(nodeFingerprint));
    expect(fps.size).toBe(1);
  });

  it('真实不同节点（server 不同）不得被误合并', () => {
    const a = mk('hk1.example.com', 443, 'vless', 'A');
    const b = mk('hk2.example.com', 443, 'vless', 'B');
    const out = deduplicateNodes([a, b]);
    expect(out).toHaveLength(2);
  });

  it('协议不同不得被误合并', () => {
    const a = mk('hk.example.com', 443, 'vless', 'A');
    const b = mk('hk.example.com', 443, 'trojan', 'B');
    expect(deduplicateNodes([a, b])).toHaveLength(2);
  });

  it('端口不同不得被误合并', () => {
    const a = mk('hk.example.com', 443, 'vless', 'A');
    const b = mk('hk.example.com', 8443, 'vless', 'B');
    expect(deduplicateNodes([a, b])).toHaveLength(2);
  });
});
