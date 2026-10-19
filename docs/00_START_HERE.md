# 文档入口

本文档以 **v2.39.0** 为维护基线。版本号以 `package.json` 为准，发布时同步更新锁文件并生成对应 Release。

SUB-Aggregation 是自托管订阅聚合服务：抓取并解析订阅、维护节点健康与地理信息，再生成客户端可用的代理配置。应用运行在单个 Node.js Docker 容器中，数据保存在 SQLite。

## 按需阅读

- 部署、备份和升级：[`DEPLOYMENT.md`](./DEPLOYMENT.md)
- 代码结构、数据流和存储：[`ARCHITECTURE.md`](./ARCHITECTURE.md)
- HTTP 路由：[`API.md`](./API.md)
- 协议解析和配置生成：[`PARSING_AND_GENERATION.md`](./PARSING_AND_GENERATION.md)
- 分流规则和 Mihomo DNS：[`RULES_AND_DNS.md`](./RULES_AND_DNS.md)
- 节点探测和 GeoIP：[`NODE_HEALTH.md`](./NODE_HEALTH.md)
- 安全边界和开发检查：[`SECURITY_AND_TESTING.md`](./SECURITY_AND_TESTING.md)
- 维护与发布约定：[`MAINTENANCE.md`](./MAINTENANCE.md)
- 节点探测细节：[`17_NODE_PROBE.md`](./17_NODE_PROBE.md)
- 性能审计：[`18_PERF_NODE_HEALTH_MIHOMO_AUDIT.md`](./18_PERF_NODE_HEALTH_MIHOMO_AUDIT.md)
- 输出同步与 GeoIP：[`20_OUTPUT_SYNC_AND_GEO.md`](./20_OUTPUT_SYNC_AND_GEO.md)

## 维护约束

1. 修改业务行为时同步更新相关文档和 `CHANGELOG.md`。
2. 升级镜像前备份数据挂载目录；SQLite 文件是运行数据的唯一持久化源。
3. 节点探测只代表基础连通性检查，不等于代理协议验证或端到端测速。
4. 任何健康状态或锁定节点逻辑的改动都要保留既有优先级规则。

实现细节以当前 `src/` 代码为准；本文档记录稳定约定。
