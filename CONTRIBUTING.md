# Contributing

欢迎对 SUB-Aggregation 做出贡献！无论是修复 Bug、添加功能还是改进文档。

## 📋 目录

- [开发流程](#-开发流程)
- [Commit 规范](#-commit-规范)
- [版本号与发布规则](#版本号与发布规则)
- [测试要求](#-测试要求)
- [代码规范](#-代码规范)
- [架构分层](#-架构分层)

## 🚀 开发流程

1. **Fork** 仓库并创建你的分支：`git checkout -b feature/xxx`
2. **开发**：小步提交，每个功能一个 commit
3. **测试**：确保新增代码有测试，`npm test` 全部通过
4. **构建**：`npm run build` 类型检查通过
5. **提交**：使用 Conventional Commit 格式
6. **Push** 并创建 Pull Request

## 📝 Commit 规范

```
type(scope): subject
```

常用类型：

- `feat:` 新功能
- `fix:` Bug 修复
- `refactor:` 代码重构（不改变功能）
- `perf:` 性能优化
- `test:` 增加/调整测试
- `docs:` 文档更新
- `chore:` 构建/工具/依赖变更

示例：

```
feat(parser): add hysteria2 parser
fix(api): handle invalid request body
test(generator): add yaml validation
docs: update deployment guide
chore: root directory cleanup
```

## 版本号与发布规则

本项目使用语义化版本 `MAJOR.MINOR.PATCH`，**版本号必须代表实际内容**：同一个版本号不允许对应不同代码。

### 递增规则

- 普通 Bug 修复、常规小更新：**PATCH + 1**（`2.38.8` → `2.38.9` → `2.38.10`）。
- 重大不兼容变更或成体系的功能升级：可递增 `MAJOR` 或 `MINOR`，但必须在 PR 或发布说明中写明理由。
- 新版本必须**严格高于**所有已发布版本。
- **禁止复用已发布版本号，禁止覆盖或移动已有 tag。**

### 当前版本

- 当前正式版本：`2.38.8`
- 下一次正式发布：`2.38.9`

### 发布前必须核对的所有版本承载位置

| 位置 | 说明 |
|---|---|
| `package.json` 的 `version` | 应用版本的**单一来源** |
| `package-lock.json` 的 `version` 与 `packages[""].version` | 只这两处需与 `package.json` 一致 |
| 运行时 `APP_META.version` | 由 `package.json` 注入（`src/meta.ts`），页面左下角显示；发布后要实际打开页面确认 |
| Docker 镜像标签 | `ghcr.io/<repo>:<version>`、`docker.io/<user>/sub-aggregation:<version>`，以及跟随最近一次正式发布的 `:latest` |
| Git tag | `vX.Y.Z`，由人工在 `main` 上创建并推送，指向版本提交 |
| GitHub Release | 标题与 tag 一致，由 tag 触发的工作流创建 |
| 文档中的「当前正式版本」 | README / CONTRIBUTING 等文档里明确写出的当前版本 |

**禁止机械递增**：依赖包版本（`dependencies`/`devDependencies`、`package-lock.json` 中的依赖条目）、API 版本、数据库迁移版本、协议版本、测试数据与示例里的数字，都**不是**应用发布版本，不得跟着 +1。

### 合并与发布分离

- 合并普通 PR 到 `main` **只跑验证**（lint / 类型检查 / 测试 / 构建），**不推送镜像、不创建 Release**。
- 正式发布只由**推送版本 tag** 触发：

  ```bash
  git tag -a v2.38.4 -m "Release v2.38.4"
  git push origin v2.38.4
  ```

- 工作流会逐项校验：tag 形如 `vX.Y.Z`、等于 `package.json` 版本、提交在 `main` 上、版本严格递增、同版本镜像若已存在则其 OCI revision 必须等于该提交。**任一不满足即拒绝发布**（宁可不发，也不覆盖已发布版本）。
- `workflow_dispatch` 只做验证，不提供任何发布参数。

### Tag 一旦推送即占用版本号（不可回收）

- 正式版本 tag **一旦创建并推送**，对应版本号就永久归它所有。
- 即使该 tag 的 CI 失败、没有生成 GitHub Release、也没有生成镜像，**也不得删除、移动、覆盖或复用该 tag**。
- 发布失败需要修复时，**必须递增到新的版本号**（例如 `2.38.6` 发布失败 → 改用 `2.38.7`），而不是回头改 `2.38.6`。
- **不得仅凭 tag 存在就认为发布成功**。正式发布须同时核对四者一致：
  1. tag 指向的提交；
  2. 该 tag 对应的正式 GitHub Release（草稿/预发布不算）；
  3. 镜像 `org.opencontainers.image.revision`（必须等于 tag 提交）；
  4. 镜像 `org.opencontainers.image.version`（必须等于 tag 版本）。
- 发布失败后，请在发布记录中注明「残留 tag 与缺失产物」（例如 `v2.38.6`：有 tag、无 Release、无镜像），
  便于 `ci-cd.yml` 的历史完整性巡检持续识别。
- 历史完整性巡检**只告警、不阻断**：它不会自动补发版本、不会补打 tag、也不会删除任何产物。

### 发布前逐项核验（发布报告需列出）

1. 目标版本严格高于**其它 tag 中的最大版本**（tag 存在 ≠ 已发布，门禁日志会分别给出"其它 tag 最大版本"与"最近一个确认存在正式 Release 的版本"）；
2. 上表所有版本字段已同步（修改前值 → 修改后值）；
3. 实际访问页面确认左下角显示的版本；
4. 镜像版本标签与 digest，且 `org.opencontainers.image.revision` 等于发布提交；
5. Git tag 与 GitHub Release 使用同一版本号并指向同一提交。

## ✅ 测试要求

所有新增功能必须有对应测试，至少覆盖：

- ✅ 正常流程
- ✅ 异常流程
- ✅ 边界情况

测试命令：

```bash
npm test          # 运行 Vitest（505 项）
npm run lint      # ESLint 检查
npx tsc --noEmit  # TypeScript 类型检查
npm run build     # 构建（含前端内嵌）
```

**测试覆盖率**：当前测试基线 505 项，提交前必须保证全绿。

## 📐 代码规范

- TypeScript strict mode
- 模块化，禁止巨型单文件
- 禁止硬编码敏感信息（API Key、Token 等）
- 遵循架构分层（API → Service → Repository → Storage）
- 敏感信息统一走环境变量（`.env`），不入库

## 🏗️ 架构分层

```
src/
├── api/           # HTTP 路由层（Hono 框架）
│   ├── routes.ts      # 所有 API 端点
│   ├── middleware.ts  # 认证 / 错误处理
│   └── rate-limit.ts  # 登录限流
├── services/      # 业务逻辑层
│   ├── auth.service.ts
│   ├── config.service.ts          # 配置生成 / 输出缓存
│   ├── config-cache.service.ts    # mihomo 输出缓存（App 版本变更即失效）
│   ├── subscription.service.ts
│   ├── node-probe.service.ts      # 节点测活 / 测速
│   ├── ip-geo.service.ts
│   ├── catalog-sync.service.ts    # 规则目录同步
│   └── operation-log.service.ts
├── engine/        # 网络层（fetchSubscription 抓取）
├── parser/        # 协议解析层
├── generator/     # 配置生成层（mihomo/singbox/shadowrocket/base64）
├── models/        # 数据模型
├── data/          # 静态规则数据
├── storage/       # 数据访问层（KV 契约 + SQLite 适配）
├── server/main.ts # Node 入口（HTTP + 定时器）
└── meta.ts        # 项目元信息
```

## 🛡️ 安全 PR 检查清单

- [ ] 无敏感信息泄漏（API Key / Token / 密码）
- [ ] 密码字段不会以明文返回 API 响应
- [ ] 用户输入已转义（防 XSS）
- [ ] 新增端点已加认证中间件
- [ ] 错误处理覆盖边界情况

## 💡 PR 模板建议

```markdown
## 改了什么
- 简要描述

## 为什么改
- 关联 issue / 需求

## 测试
- [ ] 已加单元测试
- [ ] 已加集成测试
- [ ] npm test / lint / tsc 全绿

## 截图
- UI 改动附图
```
