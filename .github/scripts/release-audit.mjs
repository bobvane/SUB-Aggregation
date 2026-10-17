#!/usr/bin/env node
/**
 * 发布门禁辅助脚本（只读）
 *
 * 两个用途：
 *   --latest-release  输出「最近一个确认存在正式 GitHub Release 的版本」，供版本门禁日志使用（A1）
 *   --audit           巡检最近若干历史版本 tag 的发布产物完整性（A2），只输出 warning，永不阻断
 *
 * 约定：
 * - 只读：不写仓库、不改 tag、不推送、不删除任何东西。
 * - 正式 Release 判定：draft === false 且 prerelease === false（草稿/预发布不算正式）。
 * - 查询失败一律标记为 unknown（未能核实），绝不当作「不存在」。
 * - GitHub API 用 GITHUB_TOKEN/GH_TOKEN（contents: read 即可读 Release）；
 *   GHCR 用匿名 pull token（公开包），不额外申请 packages: write。
 * - 镜像探测语义与 ci-cd.yml 的 Check registry state 保持一致（同样的 Accept 头与
 *   revision 标签），但这里的结果只用于告警，不参与放行判定。
 */

import { execFileSync } from 'node:child_process';

const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const DEFAULT_WINDOW = 6;

// ---------- 纯函数（可单测） ----------

export function parseVersionTag(tag) {
  const m = VERSION_RE.exec(String(tag || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareVersionTags(a, b) {
  const pa = parseVersionTag(a);
  const pb = parseVersionTag(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/** 只保留合法 vX.Y.Z 并降序 */
export function sortTagsDesc(tags) {
  const valid = (tags || []).map((t) => String(t).trim()).filter((t) => VERSION_RE.test(t));
  return [...new Set(valid)].sort((a, b) => compareVersionTags(b, a));
}

/** 正式 Release：非草稿、非预发布、tag 形如 vX.Y.Z */
export function isOfficialRelease(rel) {
  return !!rel && rel.draft === false && rel.prerelease === false && VERSION_RE.test(String(rel.tag_name || '').trim());
}

/** 最近一个正式 Release 的版本（去掉 v）；无正式 Release 返回 null */
export function pickLatestOfficialRelease(releases) {
  const official = (releases || []).filter(isOfficialRelease);
  if (!official.length) return null;
  const tags = sortTagsDesc(official.map((r) => String(r.tag_name).trim()));
  return tags.length ? tags[0].replace(/^v/, '') : null;
}

/**
 * 单个 tag 的 Release 状态：'official' | 'draft' | 'prerelease' | 'missing' | 'unknown'
 * truncated=true 且该 tag 低于已获取到的最旧 Release 版本时，标记 unknown（数据未覆盖，不能判缺失）。
 */
export function classifyReleaseForTag(tag, release, opts = {}) {
  const truncated = opts.truncated === true;
  const oldestFetchedTag = opts.oldestFetchedTag || null;
  if (release) {
    if (release.draft === true) return 'draft';
    if (release.prerelease === true) return 'prerelease';
    return 'official';
  }
  if (truncated && oldestFetchedTag && compareVersionTags(tag, oldestFetchedTag) < 0) return 'unknown';
  return 'missing';
}

/**
 * 镜像探测结果分类。
 * probe: { state: 'present' | 'absent' | 'unknown', digest?, revision?, versionLabel?, reason? }
 */
export function classifyImageProbe(probe, expectedSha) {
  const p = probe || { state: 'unknown', reason: 'no-probe-result' };
  if (p.state === 'absent') return { state: 'absent', reason: p.reason || 'manifest-404' };
  if (p.state !== 'present') return { state: 'unknown', reason: p.reason || 'probe-failed' };
  const revision = p.revision || '';
  if (expectedSha && revision && revision !== expectedSha) {
    return { state: 'revision-mismatch', reason: '镜像 revision 与 tag 提交不一致', revision: revision };
  }
  if (!revision) return { state: 'unknown', reason: '镜像缺少 OCI revision 标签', revision: revision };
  return { state: 'present', revision: revision };
}

/**
 * 巡检一组 tag（默认只看最近 windowSize 个）。
 * 结论取值：ok | missing-release | missing-image | revision-mismatch | unverified
 */
export async function auditTags(input) {
  const tags = input.tags || [];
  const releaseByTag = input.releaseByTag || new Map();
  const truncated = input.truncated === true;
  const oldestFetchedTag = input.oldestFetchedTag || null;
  const tagCommitOf = input.tagCommitOf || (() => null);
  const probeImage = input.probeImage || (async () => ({ state: 'unknown', reason: 'not-probed' }));
  const windowSize = Number(input.windowSize) > 0 ? Math.floor(Number(input.windowSize)) : DEFAULT_WINDOW;

  const sorted = sortTagsDesc(tags);
  const window = sorted.slice(0, Math.max(1, windowSize));
  const entries = [];

  for (const tag of window) {
    const version = tag.replace(/^v/, '');
    const release = releaseByTag.get(tag) || null;
    const releaseState = classifyReleaseForTag(tag, release, { truncated: truncated, oldestFetchedTag: oldestFetchedTag });
    const expectedSha = tagCommitOf(tag);
    // 总是探测镜像（窗口很小）：即使没有正式 Release，也要能报告「镜像也缺失」
    const probe = await probeImage(version);
    const image = classifyImageProbe(probe, expectedSha);
    let verdict = 'ok';
    if (releaseState === 'draft' || releaseState === 'prerelease') verdict = 'missing-release';
    else if (releaseState === 'unknown') verdict = 'unverified';
    else if (releaseState === 'missing') verdict = 'missing-release';
    else if (image.state === 'absent') verdict = 'missing-image';
    else if (image.state === 'revision-mismatch') verdict = 'revision-mismatch';
    else if (image.state === 'unknown') verdict = 'unverified';

    entries.push({ tag: tag, version: version, releaseState: releaseState, releaseUrl: release ? release.html_url : null, image: image, expectedSha: expectedSha, verdict: verdict });
  }

  const anomalies = entries.filter((e) => e.verdict !== 'ok');
  return {
    window: window,
    totalTags: sorted.length,
    truncated: truncated,
    oldestFetchedTag: oldestFetchedTag,
    entries: entries,
    anomalies: anomalies,
    summary: {
      checked: entries.length,
      ok: entries.filter((e) => e.verdict === 'ok').length,
      anomalies: anomalies.length,
      unverified: entries.filter((e) => e.verdict === 'unverified').length,
    },
  };
}

const VERDICT_TEXT = {
  'missing-release': '缺少正式 GitHub Release',
  'missing-image': '缺少 GHCR 镜像',
  'revision-mismatch': '镜像 revision 与 tag 提交不一致',
  unverified: '未能核实（查询失败或数据未覆盖）',
};

function pad(s, n) {
  const x = String(s == null ? '' : s);
  return x.length >= n ? x : x + ' '.repeat(n - x.length);
}

/** 生成报告；只输出 warning，不阻塞 */
export function formatAuditReport(result) {
  const lines = [];
  lines.push('=== 历史发布完整性巡检（只读，不阻断本次发布）===');
  lines.push('版本 tag 总数: ' + result.totalTags + '；本次检查窗口: 最近 ' + result.window.length + ' 个');
  if (result.truncated) {
    lines.push('Release 数据为分页首屏，更早于 ' + (result.oldestFetchedTag || '?') + ' 的版本未逐条核实（标记为「未核实」）');
  }
  lines.push('');
  lines.push(pad('版本', 9) + ' | ' + pad('Release', 8) + ' | ' + pad('镜像', 12) + ' | 结论');
  for (const e of result.entries) {
    const relMap = { official: '正式', draft: '草稿', prerelease: '预发布', missing: '无', unknown: '未核实' };
    const imgMap = { present: '存在', absent: '无', unknown: '未核实', 'revision-mismatch': 'revision 不符' };
    const rel = relMap[e.releaseState] || e.releaseState;
    const img = imgMap[e.image.state] || e.image.state;
    lines.push(pad(e.tag, 9) + ' | ' + pad(rel, 8) + ' | ' + pad(img, 12) + ' | ' + (e.verdict === 'ok' ? '完整' : (VERDICT_TEXT[e.verdict] || e.verdict)));
  }
  lines.push('');
  for (const e of result.entries) {
    if (e.releaseState === 'missing') {
      lines.push('::warning::' + e.tag + ' 有 tag 但没有正式 GitHub Release（tag 存在不代表已发布）');
    } else if (e.releaseState === 'draft') {
      lines.push('::warning::' + e.tag + ' 的 Release 仍是草稿（draft），不算正式发布');
    } else if (e.releaseState === 'prerelease') {
      lines.push('::warning::' + e.tag + ' 的 Release 标记为预发布（prerelease），不算最近正式版本');
    } else if (e.releaseState === 'unknown') {
      lines.push('::warning::' + e.tag + ' 的 Release 状态未能核实（数据未覆盖或查询失败）');
    }
    if (e.image.state === 'absent') {
      lines.push('::warning::' + e.tag + ' 缺少 GHCR 镜像 ' + e.version);
    } else if (e.image.state === 'revision-mismatch') {
      lines.push('::warning::' + e.tag + ' 镜像 revision 与 tag 提交不一致（期望 ' + String(e.expectedSha || '').slice(0, 12) + '，实际 ' + String(e.image.revision || '').slice(0, 12) + '）');
    } else if (e.image.state === 'unknown') {
      lines.push('::warning::' + e.tag + ' 镜像状态未能核实（原因：' + (e.image.reason || '未知') + '）');
    }
  }
  lines.push('');
  lines.push('汇总: 检查 ' + result.summary.checked + ' / 完整 ' + result.summary.ok + ' / 异常 ' + result.summary.anomalies + '（其中未核实 ' + result.summary.unverified + '）');
  lines.push(result.summary.anomalies > 0
    ? '结论: 存在历史不完整版本（见上），按策略仅告警、不阻断本次发布。'
    : '结论: 窗口内历史版本产物完整。');
  return lines.join('\n');
}

// ---------- 网络与 CLI ----------

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'sub-aggregation-release-audit' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

export async function fetchReleases(repo, token, perPage) {
  const n = perPage || 100;
  const url = 'https://api.github.com/repos/' + repo + '/releases?per_page=' + n;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('响应不是数组');
  const link = res.headers.get('link') || '';
  return { list: list, truncated: /rel="next"/.test(link) };
}

async function ghcrToken(repoPath) {
  const res = await fetch('https://ghcr.io/token?scope=repository:' + repoPath + ':pull', { headers: { 'User-Agent': 'sub-aggregation-release-audit' } });
  if (!res.ok) throw new Error('token HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.token) throw new Error('token 响应缺少 token');
  return j.token;
}

const ACCEPT = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json';

/** 探测 GHCR 镜像；语义与 ci-cd.yml 的 registry 检查一致（404=absent，异常=unknown） */
export async function probeGhcrImage(repoPath, version, tokenProvider) {
  const getToken = tokenProvider || ghcrToken;
  try {
    const token = await getToken(repoPath);
    const base = 'https://ghcr.io/v2/' + repoPath;
    const hdr = { Authorization: 'Bearer ' + token, Accept: ACCEPT, 'User-Agent': 'sub-aggregation-release-audit' };
    const res = await fetch(base + '/manifests/' + encodeURIComponent(version), { headers: hdr });
    if (res.status === 404) return { state: 'absent', reason: 'manifest-404' };
    if (!res.ok) return { state: 'unknown', reason: 'manifest HTTP ' + res.status };
    const digest = res.headers.get('docker-content-digest') || undefined;
    const manifest = await res.json();
    let cfgDigest = manifest && manifest.config ? manifest.config.digest : null;
    if (!cfgDigest && manifest && Array.isArray(manifest.manifests)) {
      const amd = manifest.manifests.find((m) => m.platform && m.platform.architecture === 'amd64' && m.platform.os === 'linux');
      if (amd) {
        const sm = await fetch(base + '/manifests/' + amd.digest, { headers: hdr });
        if (!sm.ok) return { state: 'unknown', reason: 'sub-manifest HTTP ' + sm.status };
        const sub = await sm.json();
        cfgDigest = sub && sub.config ? sub.config.digest : null;
      }
    }
    if (!cfgDigest) return { state: 'unknown', reason: 'manifest 缺少 config digest' };
    const cfgRes = await fetch(base + '/blobs/' + cfgDigest, { headers: hdr });
    if (!cfgRes.ok) return { state: 'unknown', reason: 'config blob HTTP ' + cfgRes.status };
    const cfg = await cfgRes.json();
    const labels = (cfg && cfg.config && cfg.config.Labels) || {};
    return {
      state: 'present',
      digest: digest,
      revision: labels['org.opencontainers.image.revision'] || '',
      versionLabel: labels['org.opencontainers.image.version'] || '',
    };
  } catch (e) {
    return { state: 'unknown', reason: (e && e.message) || 'probe-error' };
  }
}

async function latestReleaseCli() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!repo) return 'unknown:缺少 GITHUB_REPOSITORY';
  try {
    const r = await fetchReleases(repo, token);
    const latest = pickLatestOfficialRelease(r.list);
    return latest ? 'ok:' + latest : 'none';
  } catch (e) {
    return 'unknown:' + ((e && e.message) || 'Release 查询失败');
  }
}

async function auditCli(windowSize) {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!repo) {
    console.log('::warning::历史发布完整性巡检跳过：缺少 GITHUB_REPOSITORY');
    return;
  }
  let tags = [];
  try {
    tags = execFileSync('git', ['tag', '-l', 'v[0-9]*'], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log('::warning::历史发布完整性巡检跳过：无法读取本地 tag（' + ((e && e.message) || 'git 失败') + '）');
    return;
  }
  let releaseList = [];
  let truncated = false;
  let releaseError = null;
  try {
    const r = await fetchReleases(repo, token);
    releaseList = r.list;
    truncated = r.truncated;
  } catch (e) {
    releaseError = (e && e.message) || 'Release 查询失败';
  }
  if (releaseError) {
    console.log('::warning::历史发布完整性巡检：GitHub Release 查询失败（' + releaseError + '），本轮无法判定 Release 完整性');
  }
  const releaseByTag = new Map();
  for (const rel of releaseList) {
    if (rel && rel.tag_name) releaseByTag.set(String(rel.tag_name).trim(), rel);
  }
  let oldestFetchedTag = null;
  for (const rel of releaseList) {
    const t = rel && rel.tag_name ? String(rel.tag_name).trim() : '';
    if (!VERSION_RE.test(t)) continue;
    if (!oldestFetchedTag || compareVersionTags(t, oldestFetchedTag) < 0) oldestFetchedTag = t;
  }
  const repoPath = repo.toLowerCase();
  const result = await auditTags({
    tags: tags,
    releaseByTag: releaseByTag,
    truncated: truncated && !releaseError,
    oldestFetchedTag: oldestFetchedTag,
    windowSize: windowSize,
    tagCommitOf: (tag) => {
      try { return execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim(); } catch { return null; }
    },
    probeImage: (version) => probeGhcrImage(repoPath, version),
  });
  if (releaseError) {
    // Release 数据不可用时，不能把「查不到」当成「没有」
    for (const e of result.entries) {
      if (e.verdict === 'missing-release') {
        e.verdict = 'unverified';
        e.releaseState = 'unknown';
        e.image = { state: 'unknown', reason: 'Release 数据不可用' };
      }
    }
    result.anomalies = result.entries.filter((e) => e.verdict !== 'ok');
    result.summary.anomalies = result.anomalies.length;
    result.summary.unverified = result.entries.filter((e) => e.verdict === 'unverified').length;
    result.summary.ok = result.entries.filter((e) => e.verdict === 'ok').length;
  }
  console.log(formatAuditReport(result));
}

function main() {
  const args = process.argv.slice(2);
  const run = async () => {
    if (args.includes('--latest-release')) {
      console.log(await latestReleaseCli());
      return;
    }
    if (args.includes('--audit')) {
      const i = args.indexOf('--window');
      const w = i >= 0 ? Number(args[i + 1]) : DEFAULT_WINDOW;
      await auditCli(Number.isFinite(w) && w > 0 ? Math.floor(w) : DEFAULT_WINDOW);
      return;
    }
    console.error('用法: node .github/scripts/release-audit.mjs --latest-release | --audit [--window N]');
  };
  run().catch((e) => {
    console.log('::warning::release-audit 执行异常（已忽略，不影响发布）：' + ((e && e.message) || e));
  });
}

const selfPath = (process.argv[1] || '').replace(/\\/g, '/');
if (selfPath.endsWith('/.github/scripts/release-audit.mjs') || selfPath.endsWith('.github/scripts/release-audit.mjs')) main();

export { ghHeaders };
