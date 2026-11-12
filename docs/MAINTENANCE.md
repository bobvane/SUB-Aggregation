# 维护与发布约定

当前维护基线：**v2.46.2**。

## 分支与发布

仓库只有 `main` 一条长期分支。开发流程是「本地改完 → 推 `main` → 打 tag 发版 → NAS 拉镜像」，不额外开功能分支、不保留已合并分支。

- 推到 `main` 只触发验证（lint / 类型检查 / 测试 / 构建），不产出镜像、不创建 Release。
- 只有推送 `vX.Y.Z` tag 才触发镜像构建与 GitHub Release，门禁校验 tag 格式、与 `package.json` 一致、提交在 `main` 上、版本严格递增。
- 完整规则与「tag 一旦推送即占用版本号」的约束见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md) 的「版本号与发布规则」。

## 改动流程

1. 先定位负责模块和相关测试；保持 API、存储键、UI 与生成配置之间的约定一致。
2. 规则语义、节点锁定优先级、健康状态含义属于稳定行为，变更前补测试并说明迁移影响。
3. 更新版本时同步 `package.json` 与 `package-lock.json`；`src/meta.ts` 从 `package.json` 读取版本，无需重复硬编码。
4. 更新与改动直接相关的文档，运行 [`SECURITY_AND_TESTING.md`](./SECURITY_AND_TESTING.md) 所列检查。
5. 发布后确认镜像标签（`:X.Y.Z` 与 `:latest` 同一 digest）和容器健康状态；健康历史保留 30 天，DNS 缓存保留 6 小时，IP 归属缓存保留 30 天。

## 依赖更新

依赖更新由 `.github/dependabot.yml` 每月批量提出，按生产 / 开发分组，`target-branch` 固定为 `main`，PR 上限 2 条。

本机 `npm audit fix` 在 npm 10.x 上可能崩溃（`Cannot read properties of null (reading 'edgesOut')`）。遇到时改为手工 `npm install <pkg>@<version>`，需要强制提升嵌套依赖时用 `package.json` 的 `overrides`。判断风险以 `npm audit --omit=dev` 为准：构建期 `devDependencies` 不进运行镜像。

## 不保留的文档内容

文档以当前实现和可复用操作为主。一次性审计过程、过期路线图、重复的 NAS 现场记录不作为独立长篇文档维护；仍有价值的结论放回对应专题页。源码和测试是实现细节的最终依据。
