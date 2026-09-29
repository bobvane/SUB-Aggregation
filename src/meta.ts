/**
 * 项目元信息：名称、版本、仓库、作者、链接
 * 集中管理，供前端 /api/meta 与页脚展示使用
 */
export const APP_META = {
  name: 'SUB-Aggregation',
  version: '2.37.1',
  repo: 'https://github.com/bobvane/SUB-Aggregation',
  repoShort: 'bobvane/SUB-Aggregation',
  author: 'Bob Vane',
  description: '订阅聚合与配置生成平台（NAS / Docker 部署）',
} as const;

/** 记录一个版本是否比当前版本新（语义化 semver 简单比较） */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}