/**
 * 发布门禁辅助脚本（.github/scripts/release-audit.mjs）的单元测试（v2.38.8 A1/A2）
 *
 * 覆盖：版本解析/排序、正式 Release 判定（排除草稿与预发布）、
 *      Release/镜像/ revision 三类异常的判定、查询失败的 fail-safe、
 *      巡检窗口与不阻断语义、报告文案。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseVersionTag,
  compareVersionTags,
  sortTagsDesc,
  isOfficialRelease,
  pickLatestOfficialRelease,
  classifyReleaseForTag,
  classifyImageProbe,
  auditTags,
  formatAuditReport,
} from '../../.github/scripts/release-audit.mjs';

describe('版本解析与排序', () => {
  it('只接受 vX.Y.Z，按语义化降序', () => {
    expect(parseVersionTag('v2.38.7')).toEqual({ major: 2, minor: 38, patch: 7 });
    expect(parseVersionTag('2.38.7')).toBeNull();
    expect(parseVersionTag('v2.38.7-rc1')).toBeNull();
    // 语义化排序：2.38.10 > 2.38.7 > 2.38.2 > 2.9.0
    expect(sortTagsDesc(['v2.9.0', 'v2.38.2', 'v2.38.10', 'nightly', 'v2.38.7'])).toEqual([
      'v2.38.10', 'v2.38.7', 'v2.38.2', 'v2.9.0',
    ]);
    expect(compareVersionTags('v2.38.10', 'v2.38.9')).toBeGreaterThan(0);
  });
});

describe('正式 Release 判定（A1）', () => {
  const rel = (tag_name: string, extra: Record<string, unknown> = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });

  it('草稿与预发布都不算正式发布', () => {
    expect(isOfficialRelease(rel('v2.38.7'))).toBe(true);
    expect(isOfficialRelease(rel('v2.38.7', { draft: true }))).toBe(false);
    expect(isOfficialRelease(rel('v2.38.7', { prerelease: true }))).toBe(false);
    expect(isOfficialRelease(rel('nightly'))).toBe(false);
    expect(isOfficialRelease(null)).toBe(false);
  });

  it('最近正式版本忽略草稿/预发布，取语义化最大值', () => {
    expect(pickLatestOfficialRelease([
      rel('v2.38.7'),
      rel('v2.38.8', { draft: true }),
      rel('v2.39.0', { prerelease: true }),
      rel('v2.38.5'),
    ])).toBe('2.38.7');
    expect(pickLatestOfficialRelease([rel('v2.38.9', { draft: true })])).toBeNull();
    expect(pickLatestOfficialRelease([])).toBeNull();
  });

  it('缺少 Release 与数据未覆盖必须区分', () => {
    expect(classifyReleaseForTag('v2.38.6', null, {})).toBe('missing');
    // 分页截断 + 比最旧已获取版本更早 → 未核实，不能判定为缺失
    expect(classifyReleaseForTag('v2.0.1', null, { truncated: true, oldestFetchedTag: 'v2.12.15' })).toBe('unknown');
    // 未截断时，查不到就是真的没有
    expect(classifyReleaseForTag('v2.0.1', null, { truncated: false, oldestFetchedTag: 'v2.12.15' })).toBe('missing');
    expect(classifyReleaseForTag('v2.38.6', { draft: true, prerelease: false })).toBe('draft');
    expect(classifyReleaseForTag('v2.38.6', { draft: false, prerelease: true })).toBe('prerelease');
  });
});

describe('镜像探测结果分类（A2）', () => {
  it('404 = 不存在；异常 = 未核实（绝不把查询失败当不存在）', () => {
    expect(classifyImageProbe({ state: 'absent', reason: 'manifest-404' }, 'abc').state).toBe('absent');
    expect(classifyImageProbe({ state: 'unknown', reason: 'manifest HTTP 500' }, 'abc').state).toBe('unknown');
    expect(classifyImageProbe(null, 'abc').state).toBe('unknown');
  });

  it('revision 一致 = present；不一致 = revision-mismatch；缺 revision = unknown', () => {
    expect(classifyImageProbe({ state: 'present', revision: 'abc' }, 'abc').state).toBe('present');
    expect(classifyImageProbe({ state: 'present', revision: 'deadbeef' }, 'abc').state).toBe('revision-mismatch');
    expect(classifyImageProbe({ state: 'present', revision: '' }, 'abc').state).toBe('unknown');
  });
});

describe('巡检聚合（auditTags）', () => {
  const tags = ['v1.0.0', 'v2.38.5', 'v2.38.6', 'v2.38.7'];
  const officialAll = new Map([
    ['v2.38.5', { tag_name: 'v2.38.5', draft: false, prerelease: false }],
    ['v2.38.6', { tag_name: 'v2.38.6', draft: false, prerelease: false }],
    ['v2.38.7', { tag_name: 'v2.38.7', draft: false, prerelease: false }],
  ]);
  const sha = (tag: string) => 'sha-' + tag;

  it('全部完整 → 无异常', async () => {
    const r2 = await auditTags({
      tags, releaseByTag: officialAll, windowSize: 3,
      tagCommitOf: sha,
      probeImage: async (v: string) => ({ state: 'present', revision: 'sha-v' + v }),
    });
    expect(r2.entries.length).toBe(3);
    expect(r2.anomalies).toHaveLength(0);
    expect(r2.summary).toMatchObject({ checked: 3, ok: 3, anomalies: 0, unverified: 0 });
  });

  it('缺少 Release → missing-release，且仍会报告镜像缺失', async () => {
    const releaseByTag = new Map([['v2.38.5', officialAll.get('v2.38.5')!], ['v2.38.7', officialAll.get('v2.38.7')!]]);
    const result = await auditTags({
      tags, releaseByTag, windowSize: 3, tagCommitOf: sha,
      probeImage: async () => ({ state: 'absent', reason: 'manifest-404' }),
    });
    const v236 = result.entries.find((e) => e.tag === 'v2.38.6')!;
    expect(v236.releaseState).toBe('missing');
    expect(v236.verdict).toBe('missing-release');
    expect(v236.image.state).toBe('absent');
    const text = formatAuditReport(result);
    expect(text).toContain('v2.38.6 有 tag 但没有正式 GitHub Release');
    expect(text).toContain('v2.38.6 缺少 GHCR 镜像');
    expect(text).toContain('不阻断');
  });

  it('有 Release 但缺镜像 → missing-image', async () => {
    const result = await auditTags({
      tags, releaseByTag: officialAll, windowSize: 3, tagCommitOf: sha,
      probeImage: async (v: string) => (v === '2.38.6' ? { state: 'absent', reason: 'manifest-404' } : { state: 'present', revision: 'sha-v' + v }),
    });
    expect(result.entries.find((e) => e.tag === 'v2.38.6')!.verdict).toBe('missing-image');
    expect(formatAuditReport(result)).toContain('缺少 GHCR 镜像 2.38.6');
  });

  it('镜像 revision 与 tag 提交不一致 → revision-mismatch', async () => {
    const result = await auditTags({
      tags, releaseByTag: officialAll, windowSize: 3, tagCommitOf: sha,
      probeImage: async () => ({ state: 'present', revision: 'someone-else' }),
    });
    expect(result.entries.every((e) => e.verdict === 'revision-mismatch')).toBe(true);
    expect(formatAuditReport(result)).toContain('镜像 revision 与 tag 提交不一致');
  });

  it('查询失败 → unverified（不误判为缺失，也不阻断）', async () => {
    const result = await auditTags({
      tags, releaseByTag: officialAll, windowSize: 3, tagCommitOf: sha,
      probeImage: async () => ({ state: 'unknown', reason: 'manifest HTTP 503' }),
    });
    expect(result.entries.every((e) => e.verdict === 'unverified')).toBe(true);
    const text = formatAuditReport(result);
    expect(text).toContain('未能核实');
    expect(text).toContain('不阻断');
    expect(text).not.toContain('缺少 GHCR 镜像');
  });

  it('只检查窗口内的版本（限制 API 调用次数）', async () => {
    const probe = vi.fn(async (v: string): Promise<{ state: 'present'; revision: string }> => ({ state: 'present', revision: 'sha-v' + v }));
    const result = await auditTags({
      tags: ['v2.38.1', 'v2.38.2', 'v2.38.3', 'v2.38.4', 'v2.38.5', 'v2.38.6', 'v2.38.7'],
      releaseByTag: officialAll, windowSize: 2, tagCommitOf: sha, probeImage: probe,
    });
    expect(result.window).toEqual(['v2.38.7', 'v2.38.6']);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('Release 数据分页截断时，超出范围的旧版本标为未核实', async () => {
    const result = await auditTags({
      tags: ['v1.0.0', 'v2.38.7'], releaseByTag: new Map([['v2.38.7', officialAll.get('v2.38.7')!]]),
      truncated: true, oldestFetchedTag: 'v2.12.15', windowSize: 2, tagCommitOf: sha,
      probeImage: async () => ({ state: 'present', revision: 'sha-v1.0.0' }),
    });
    expect(result.entries.find((e) => e.tag === 'v1.0.0')!.releaseState).toBe('unknown');
    expect(result.entries.find((e) => e.tag === 'v1.0.0')!.verdict).toBe('unverified');
  });
});

describe('报告文案（A1/A2 语义）', () => {
  it('完整场景给出明确结论，不出现“上一个已发布版本”式表述', async () => {
    const result = await auditTags({
      tags: ['v2.38.7'], releaseByTag: new Map([['v2.38.7', { tag_name: 'v2.38.7', draft: false, prerelease: false }]]),
      windowSize: 1, tagCommitOf: () => 'sha', probeImage: async () => ({ state: 'present', revision: 'sha' }),
    });
    const text = formatAuditReport(result);
    expect(text).toContain('窗口内历史版本产物完整');
    expect(text).not.toContain('上一个已发布版本');
  });
});
