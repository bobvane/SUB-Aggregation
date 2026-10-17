/**
 * .github/scripts/release-audit.mjs 的类型声明（仅供测试与 tsc 使用）
 */

export interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string | null;
}

export type ReleaseState = 'official' | 'draft' | 'prerelease' | 'missing' | 'unknown';
export type ImageState = 'present' | 'absent' | 'unknown' | 'revision-mismatch';
export type Verdict = 'ok' | 'in-progress' | 'missing-release' | 'missing-image' | 'revision-mismatch' | 'unverified';

export interface ImageProbe {
  state: 'present' | 'absent' | 'unknown';
  digest?: string;
  revision?: string;
  versionLabel?: string;
  reason?: string;
}

export interface AuditEntry {
  tag: string;
  version: string;
  releaseState: ReleaseState;
  releaseUrl: string | null;
  image: ImageProbe & { state: ImageState };
  expectedSha: string | null;
  verdict: Verdict;
  /** true = 本次正在发布的 tag（缺 Release/镜像属正常，不计入历史异常） */
  inProgress?: boolean;
}

export interface AuditResult {
  window: string[];
  totalTags: number;
  truncated: boolean;
  oldestFetchedTag: string | null;
  entries: AuditEntry[];
  anomalies: AuditEntry[];
  summary: { checked: number; ok: number; anomalies: number; unverified: number; inProgress?: number };
}

export function parseVersionTag(tag: string): { major: number; minor: number; patch: number } | null;
export function compareVersionTags(a: string, b: string): number;
export function sortTagsDesc(tags: string[]): string[];
export function resolveCurrentTag(refName: string | null | undefined): string;
export function isOfficialRelease(rel: GitHubRelease | null | undefined): boolean;
export function pickLatestOfficialRelease(releases: GitHubRelease[]): string | null;
export function classifyReleaseForTag(
  tag: string,
  release: GitHubRelease | null,
  opts?: { truncated?: boolean; oldestFetchedTag?: string | null },
): ReleaseState;
export function classifyImageProbe(
  probe: ImageProbe | null | undefined,
  expectedSha?: string | null,
): { state: ImageState; reason?: string; revision?: string };
export function auditTags(input: {
  tags: string[];
  releaseByTag?: Map<string, GitHubRelease>;
  truncated?: boolean;
  oldestFetchedTag?: string | null;
  tagCommitOf?: (tag: string) => string | null;
  probeImage?: (version: string) => Promise<ImageProbe>;
  windowSize?: number;
  /** 本次正在发布的 tag（vX.Y.Z）；缺 Release/镜像不计入历史异常 */
  currentTag?: string;
}): Promise<AuditResult>;
export function formatAuditReport(result: AuditResult): string;
export function probeGhcrImage(
  repoPath: string,
  version: string,
  tokenProvider?: (repoPath: string) => Promise<string>,
): Promise<ImageProbe>;
export function fetchReleases(repo: string, token: string, perPage?: number): Promise<{ list: GitHubRelease[]; truncated: boolean }>;
export function ghHeaders(token: string): Record<string, string>;
