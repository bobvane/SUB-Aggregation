# 安全与开发检查

## 安全边界

- 管理员密码使用 PBKDF2-SHA256 与随机盐存储；会话为 HttpOnly Cookie，密码变更会使旧会话失效。
- 订阅抓取拒绝本地/私有地址并重新校验重定向目标，避免 SSRF。
- 登录和敏感操作有速率限制；API 错误不应返回堆栈或密钥。
- `/sub/:format/:token` 的 token 等同密码；不要记录或公开它。
- `.env`、数据库、构建目录和本地审查文件不得提交。公开部署管理界面时，应使用 HTTPS 和额外的网络访问控制。

安全漏洞请勿公开提交，按根目录 [`SECURITY.md`](../SECURITY.md) 的私下报告流程处理。

## 修改后的检查

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` 会执行 HTML 内嵌和 TypeScript 类型检查；Dockerfile 构建也会运行全量测试。文档不固定测试数量，以当前运行结果为准。

涉及 API、解析器、规则、探测、SQLite 或认证的修改，应补充对应层级的测试；涉及配置生成时，检查所有支持格式和节点筛选一致性。
