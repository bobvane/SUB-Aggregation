# 分流规则与 Mihomo DNS

## 规则来源

- 固定规则组和规则映射定义在 `src/data/metacubex-rules.ts`。
- 用户自定义规则存入 SQLite；规则目录由 `src/services/catalog-sync.service.ts` 同步 MetaCubeX 分类。
- `src/generator/mihomo.ts` 组装策略组和规则；`src/generator/rule-providers.ts` 仅为用户选择的目录项生成 provider。
- 规则组被关闭时，其对应规则也必须一起排除，避免残留规则引用不存在的组。

新增或调整规则时，先检查命中目标、默认策略和规则顺序，再更新 `tests/data/` 与 `tests/generator/`。不要为了性能改变规则语义。

## DNS 与 TUN

Mihomo 基础配置在 `src/generator/mihomo.ts` 的 `BASE_LAYER`。其中包含 fake-IP、DNS 劫持、nameserver-policy、fallback、sniffer 和严格路由等配置。

DNS 防泄漏设计依赖客户端启用 **TUN 模式**；仅启用系统代理时，系统 DNS 可能绕过内核。需要排查 DNS 行为时，应在实际客户端、实际 TUN 设置下验证，不要把生成 YAML 的静态检查当成端到端证明。

涉及 DNS 字段时，检查 Mihomo 官方配置规范及本项目生成测试；避免暴露 `external-controller`、控制面板或未受保护的 API。
