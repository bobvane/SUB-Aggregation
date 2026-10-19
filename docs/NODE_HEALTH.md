# 节点探测与地理归属

## 探测能力边界

`src/services/node-probe.service.ts` 当前测的是 NAS 到节点服务器的基础连通性：TCP 握手，以及适用时的 TLS 握手。多次采样用于降低单次网络抖动影响。结果**不是代理协议验证，也不是客户端端到端延迟**。

Hysteria2、TUIC、WireGuard 属于 UDP 探测不适用的协议；其探测状态为 `unknown`，不会因 TCP 探测不适用而从配置中剔除。客户端的 Mihomo `url-test` 才负责实际代理请求下的选择。

健康历史写入 `health:hist:*` 和 `health:latest:*`。探测版本键用于识别探测器、评分公式和数据结构版本；升级时不要随意删除健康历史，否则会改变节点筛选结果。

节点筛选优先级以 `src/services/config.service.ts` 为准：锁定节点绕过自动健康/移除筛选；其他节点按用户禁用状态、健康状态和下线状态决定是否输出。任何变更都要检查所有配置格式的一致性。

## GeoIP

`src/services/ip-geo.service.ts` 先解析域名节点的 IPv4，再批量查询国家归属并缓存。无法识别的 IP 通过持久化门闩安排有限次数重试；持续失败会保留待处理结果供管理界面提示。

Node 内置 `fetch` 访问 DoH 或 GeoIP 服务需按网络环境配置代理。代理设置详见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。
