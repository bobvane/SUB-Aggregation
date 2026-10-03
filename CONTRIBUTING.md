# Contributing

欢迎对 SUB-Aggregation 做出贡献！无论是修复 Bug、添加功能还是改进文档。

## 📋 目录

- [开发流程](#-开发流程)
- [Commit 规范](#-commit-规范)
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
