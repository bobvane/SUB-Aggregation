# 文档入口

本文档以 **v2.46.1** 为维护基线。版本号以 `package.json` 为准，发布时同步更新锁文件并生成对应 Release。

SUB-Aggregation 是自托管订阅聚合服务：抓取并解析订阅、维护节点健康与地理信息，再生成客户端可用的代理配置。应用运行在单个 Node.js Docker 容器中，数据保存在 SQLite。

## 第一次部署

- [`../README.md`](../README.md)：部署三步、第一次打开按什么顺序点、常见问题
- [`DEPLOYMENT.md`](./DEPLOYMENT.md)：Docker / NAS 安装、出网代理设置、备份与恢复

## 实现与约定

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)：代码结构、数据流、存储键、出网代理决策顺序
- [`API.md`](./API.md)：HTTP 路由索引、代理相关字段、认证与敏感信息
- [`PARSING_AND_GENERATION.md`](./PARSING_AND_GENERATION.md)：协议解析链路与四种输出格式
- [`RULES_AND_DNS.md`](./RULES_AND_DNS.md)：分流规则来源、规则组与 Mihomo DNS
- [`NODE_HEALTH.md`](./NODE_HEALTH.md)：节点探测的能力边界与 GeoIP 流程
- [`SECURITY_AND_TESTING.md`](./SECURITY_AND_TESTING.md)：安全边界、改动后的检查项
- [`MAINTENANCE.md`](./MAINTENANCE.md)：维护与发布约定

## 专题与历史记录

以下文档记录特定版本的技术细节或调研过程，结论可能已被后续版本覆盖；**当前语义以上面「实现与约定」为准**。

- [`17_NODE_PROBE.md`](./17_NODE_PROBE.md)：节点探测、自动命名与地理组排序的细节
- [`18_PERF_NODE_HEALTH_MIHOMO_AUDIT.md`](./18_PERF_NODE_HEALTH_MIHOMO_AUDIT.md)：前端性能、节点健康口径与 Mihomo 自动选择组审查
- [`19_PROXY_AVAILABILITY_DESIGN.md`](./19_PROXY_AVAILABILITY_DESIGN.md)：真实代理可用性检测方案设计（v2.37.3 基线，结论已落地）
- [`20_OUTPUT_SYNC_AND_GEO.md`](./20_OUTPUT_SYNC_AND_GEO.md)：国家码检测、订阅同步与输出配置（v2.38.6 基线）
- [`21_PROXY_USAGE_AUDIT.md`](./21_PROXY_USAGE_AUDIT.md)：项目代理使用调研（v2.43.1 基线，改造前后对照）

## 维护约束

1. 修改业务行为时同步更新相关文档和 `CHANGELOG.md`。
2. 升级镜像前备份数据挂载目录；SQLite 文件是运行数据的唯一持久化源。
3. 节点探测只代表基础连通性检查，不等于代理协议验证或端到端测速。
4. 任何健康状态或锁定节点逻辑的改动都要保留既有优先级规则。
5. 仓库只维护 `main` 一条长期分支；改完直接推 `main`，发版靠打 `vX.Y.Z` tag。

实现细节以当前 `src/` 代码为准；本文档记录稳定约定。
