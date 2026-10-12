# 18 · 专项技术审查：前端性能 / 节点健康口径 / Mihomo 自动选择组

> **原文状态说明（2026-07 登记）**：本文原为约 737 行的只读专项审查报告，含 §1–§12。
> §1–§12 在早期工作流中因文档写入事故丢失（该文件从未纳入 Git 版本管理，
> 也无其他可核实备份来源）。依据 P1 复审指令：不编造已丢失章节，不用 P1 设计报告
> （docs/19）替代旧审计正文。当前仅保留 §13「节点可用性闭环」，该章节在 P0 最终
> 验收（m00972）阶段完整写出，内容仍有效。

## 十三、节点可用性闭环审计（P0 最终验收 · m00972）

> 本轮为 P0 最终验收专项：确认「节点健康检测 → dropped → Mihomo 配置」闭环是否真正闭合，
> 并回答用户实际使用中发现的「项目判定不可用节点仍出现在 Mihomo 配置」问题。
> 所有结论基于实际代码路径阅读，非猜测。

### 13.1 数据流追踪：Mihomo 节点到底来自哪？

```text
repos.nodes.getAll()            ← 全量原始节点（含停用订阅排除）
  ↓ deduplicateNodes()
  ↓ getNodes()（src/services/config.service.ts:305）
     locked 豁免 → disabled → dropped → status==='disabled' → removed_at → 【v2.38 P0 闭环】UDP unknown 过滤
  ↓
generate()（:368）— 所有格式（mihomo/singbox/v2ray/v2rayn/nekoray/shadowrocket）
  共用同一 getNodes() 结果（:379）→ 无第二条未过滤数据源
  ↓
generateMihomoConfig（src/generator/mihomo.ts:722）
  makeUniqueNames(nodes) → uniqueNodes → proxies + generateProxyGroups
  allGeoNodes(:349) 来自过滤后集合 → 顶层扁平化未绕过健康过滤
  ↓
最终 YAML proxies + proxy-groups
```

**结论：无泄漏路径。** 所有格式共用同一 `getNodes()`，`generateMihomoConfig` 的 `allGeoNodes`/地区组/LB组/业务组/GLOBAL 全部来自同一过滤后集合。不存在「某组直接读原始订阅节点」的旁路。

### 13.2 逐项回答（10 问）

**Q1：项目当前所谓「测试通过」到底证明什么？**
当前 `probeNode` 证明的是 **TCP 连接可达 + TLS 握手成功（若有 TLS）**。
这代表「NAS 到服务器端口的网络路径通」，**不代表代理协议层（VLESS/VMess/Trojan/SS）可正常工作**。
一个端口开着但代理协议配置错误、token 失效、证书不匹配的节点，TCP/TLS 可通但实际不可用。

**Q2：TCP/TLS 成功是否等于代理可用？**
**否。** 这是本项目的能力边界：当前健康检测只能证明基础网络/握手连通性。
不得把 `tcpLatency`/`tlsLatency` 标注为「真实代理延迟」。真实代理端到端延迟由客户端 Mihomo url-test 负责。

**Q3：哪些状态会进入 dropped？**
- `statusMachine === 'disabled'`（连续 ≥3 轮失败确认）→ 规则① 剔除
- 慢节点：`latest 延迟 > 阈值` 且 最近 3 条历史 ≥2 条 > 阈值 → 规则② 剔除
- UDP unknown 节点：不写健康数据 → 两条规则均不触发 → **不进 dropped**
  但经 `getNodes()` 的 P0 闭环过滤（`!isProbeApplicable` → `return false`）→ **不进自动配置**

**Q4：哪些状态可以进入最终 Mihomo 配置？**
| 状态 | 是否进配置 | 说明 |
|---|---|---|
| `alive` + `active/suspect` | ✅ 进 | 正常节点 |
| `dead` + `suspect`（<3 轮） | ✅ 进 | 复核中，保留 |
| `dead` + `disabled`（≥3 轮） | ❌ 不进 | 规则① 剔除 |
| 慢节点（规则②） | ❌ 不进 | 剔除 |
| UDP `unknown`（未锁定） | ❌ 不进 | P0 闭环：基础探测无法证明其可用 |
| UDP `unknown`（锁定） | ✅ 进 | v2.36.9 锁定语义优先 |
| 用户主动禁用（`status='disabled'`） | ❌ 不进 | 用户意图 |
| 锁定节点 | ✅ 进 | 豁免一切过滤 |

**Q5：dead/disabled 节点是否可能从其他配置路径重新进入？**
**否。** 所有格式共用 `getNodes()`，`generateMihomoConfig` 的 `allGeoNodes`/地区组/LB组/业务组/GLOBAL
全部来自同一过滤后集合。GLOBAL 全量回填回填的是**组名**（非节点名），不会重新引入被剔除节点。

**Q6：unknown 节点最终如何处理？**
UDP 协议（hysteria2/tuic/wireguard）`probeNode` 早退返回 `unknown`，不写 `health:latest`/`health:hist`/状态机。
`getDroppedNodes` 两条规则均不触发（无健康数据可读）。
**v2.38 P0 闭环**：`getNodes()` 新增 `!isProbeApplicable(n.protocol)` 过滤 → 非锁定 UDP 节点不进自动配置。
锁定 UDP 节点（`locked.has(fp)`）在过滤链最前 `return true` → 强制进配置（v2.36.9 既有语义保留）。

**Q7：locked 节点有什么特殊语义？**
锁定节点豁免一切过滤：即使用户禁用、系统剔除（dropped）、状态机 disabled、UDP unknown、removed，
锁定节点仍强制进入配置。这是 v2.36.9 既有设计，本次 P0 闭环审计**未改动**该语义。

**Q8：最终 Mihomo 配置是否只引用经过统一健康过滤的节点集合？**
**是。** `generate()` 所有格式共用 `getNodes()` 结果；`generateMihomoConfig` 内部 `allGeoNodes`/`geoChoices`/
地区组/LB 组/业务组/GLOBAL 全部派生自同一 `uniqueNodes`（经 `makeUniqueNames` 去重后）。
不存在「主节点池已过滤但某 proxy-group 又引用了被剔除节点」的脱节。

**Q9：本次是否真正解决了「项目判定不可用节点仍出现在 Mihomo 配置」的问题？**
**配置过滤层面：是。** `getNodes()` 统一过滤 + `generateMihomoConfig` 单一数据源 → 被剔除节点
（disabled/dropped/用户禁用/removed/非锁定 UDP）不会进入最终 YAML。集成测试
`tests/integration/node-health-mihomo-closure.test.ts` 8 用例验证了完整闭环。
**但检测能力层面：否。** 当前 TCP/TLS 探测无法识别「端口开着但代理协议层异常」的节点。
这类节点 TCP/TLS 可通 → 判 `alive` → 进配置 → 客户端实际不可用。
**解决此类问题需要真实 Mihomo 代理探测（方案 B），属于后续独立任务，不在本轮范围。**

**Q10：哪些问题仍然属于「当前探测能力无法证明」，需要后续通过 Mihomo 实际代理探测解决？**
- VLESS/VMess/Trojan/SS 协议层认证失败（token/ID/证书不匹配）→ 当前无法检测
- 代理服务器端口开着但后端已失效 → 当前无法检测
- UDP 协议（hysteria2/tuic/wireguard）的 QUIC 层可用性 → 当前返回 unknown 保守处理
- 节点实际吞吐量/带宽 → 当前未测
- 节点地理位置偏差（声称 HK 实际 US）→ 当前仅靠 ip-geo，非探测

### 13.3 本次 P0 闭环源码改动

| 文件 | 改动 |
|---|---|
| `src/services/config.service.ts` | `getNodes()` 新增 `if (!isProbeApplicable(n.protocol)) return false;` —— 非锁定 UDP 节点不进自动配置 |

这是**最小修改**，不复制过滤逻辑，统一在 `getNodes()` 一处过滤。

### 13.4 本次 P0 闭环新增测试

| 测试文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/integration/node-health-mihomo-closure.test.ts` | 8 | A(disabled) 不进 proxies+groups；B(healthy) 进；C(UDP unknown) 不进；C+locked 进；完整闭环；慢节点 slow→normal→slow 3 用例 |
| `tests/services/node-probe-latch.test.ts` | 2 | 并发门闩：同周期并发调用→第二轮在第一轮完成后才启动；in-flight 排队为下一轮 |
| `tests/integration/engine-cold-start-closure.test.ts` | 2 | 引擎 2→3 reset→首轮 suspect 不剔除→配置保留→API 不 500 |

### 13.5 最终测试与验证结果

```text
npm test          → 60 文件 / 562 测试全绿 ✅
npx tsc --noEmit  → 通过 ✅
npx eslint . --ext .ts → 通过 ✅
npm run build:html → 生成 src/html.js（108,603 bytes）✅
Mihomo 生成层测试  → mihomo.test.ts + mihomo-v238-p0.test.ts 全绿 ✅
配置闭环测试        → node-health-mihomo-closure.test.ts 8/8 ✅
```

### 13.6 精确回滚方案（不用 `git checkout -- tests/` 粗粒度）

本次 P0 闭环审计修改/新增的**精确文件列表**：

**修改（M）：**
```
src/services/config.service.ts
```

**新增（??）：**
```
tests/integration/node-health-mihomo-closure.test.ts
tests/integration/engine-cold-start-closure.test.ts
tests/services/node-probe-latch.test.ts
```

**回滚命令：**
```bash
cd /path/to/SUB-Aggregation
# 回滚源码改动
git checkout -- src/services/config.service.ts
# 删除新增测试文件
rm tests/integration/node-health-mihomo-closure.test.ts
rm tests/integration/engine-cold-start-closure.test.ts
rm tests/services/node-probe-latch.test.ts
# 重新生成前端内嵌
npm run build:html
# 重启容器
docker compose down && docker compose up -d
```

> 注意：`git checkout -- src/services/config.service.ts` 回滚的是整个文件，
> 该文件在 P0 闭环审计之前已有 P0-2/P0-3 改动（`getDroppedNodes` 双规则重写）。
> 如果只想回滚 P0 闭环审计的 UDP 过滤行而不回滚 P0-2 双规则重写，
> 需手动删除 `getNodes()` 中的 `if (!isProbeApplicable(n.protocol)) return false;` 一行，
> 以及 `const { isProbeApplicable } = await import('./node-probe.service');` 一行。
