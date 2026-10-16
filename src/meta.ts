import pkg from '../package.json';

/**
 * 项目元信息：名称、版本、仓库、作者、链接
 * 集中管理，供前端 /api/meta 与页脚展示使用
 *
 * **版本号单一来源：`package.json`**（v2.38.3 修复）。
 * 背景：此处曾是硬编码字面量，v2.38.2 发版只改了 package.json，
 * 导致镜像内 `APP_META.version` 仍停留在 2.38.1，页脚与实际运行版本不一致。
 * 现在构建时由 esbuild 把 package.json 内联进 dist/server.mjs（resolveJsonModule 已启用），
 * 运行时无需读取 package.json 文件；发版只改 package.json 一处即可。
 */
export const APP_META = {
  name: 'SUB-Aggregation',
  version: pkg.version,
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