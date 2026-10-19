# 订阅解析与配置生成

## 输入与解析

`src/parser/` 将 URI 节点列表、Base64 订阅、Clash YAML 和 3x-ui 订阅解析为统一的 `Node`。

支持的节点协议：VMess、VLESS、Trojan、Shadowsocks、ShadowsocksR、Hysteria2、TUIC、WireGuard、AnyTLS。

解析链路：检测订阅类型 → 解码文本 → 按协议解析 → 字段归一化 → 按 `server:port:protocol` 去重。尽可能保留原始 URI 和未知参数，方便复制或导出时保持兼容。

主要代码：`src/parser/detector.ts`、`decoder.ts`、`index.ts`、各 `*.parser.ts` 和 `clash.ts`。新增协议时补解析器、类型定义、生成器支持情况及协议测试。

## 输出格式

API 接受的格式由 `src/api/routes.ts` 白名单控制：

| 格式 | 输出 |
|---|---|
| `mihomo` | Clash Meta / Mihomo YAML，含策略组、分流规则和运行所需配置 |
| `singbox` | sing-box JSON |
| `shadowrocket` | Shadowrocket 原生配置 |
| `v2ray`、`v2rayn`、`nekoray` | Base64 编码的节点分享链接列表 |

某种输出不支持的节点协议会被跳过。URI 导出优先复用原始链接；没有原始链接时由 `src/generator/node-to-url.ts` 序列化。

生成器入口在 `src/services/config.service.ts`，格式实现位于 `src/generator/`。所有格式共享同一节点筛选结果；修改筛选、命名或序列化时，检查 `tests/generator/` 和 `tests/integration/` 中的保真与一致性用例。
