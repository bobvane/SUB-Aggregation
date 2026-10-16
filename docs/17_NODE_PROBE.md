# 17 · 节点探测与自动命名

节点列表的三条核心逻辑：连通性探测（TCP/TLS 握手 RTT，非真实代理延迟）、自动命名、地理组排序。
所有探测结果与命名不写节点库，只在输出/展示时生效——库里节点名保持原始。
探测数据（健康历史/快照）走 KV 存储（`health:*` 键），复用 SqliteAdapter。

## 1. 探测引擎（node-probe.service.ts）

**v2.36 起改为真实握手探测**，不再测「穿节点 HTTP 204」：
穿透必须实现 VLESS/VMess 客户端，本机 `fetch` 量的是服务器自己而非节点（旧实现如此，已删）。
可达性由 TCP / TLS 握手判定，延迟取 TLS RTT（有）否则 TCP RTT。

**v2.38（P0）：基础连通性探测，非真实代理延迟。**
当前探测仅执行 TCP 连接与 TLS 握手，**不执行** VLESS/VMess/Trojan/Shadowsocks 等代理协议。
测得的是「NAS → 服务器端口」的握手 RTT，代表基础网络连通性，**不代表代理可用或端到端延迟**。
真实代理请求成功率与端到端延迟由客户端 Mihomo 自动选择组（url-test）负责。

```
TCP 握手（node:net 真实三次握手 RTT）
  → 失败则 status=dead，跳过后续
  │
TLS 握手（node:tls，rejectUnauthorized:false；仅 tls 节点叠加，SNI 用节点 sni）
  → 挡「假通」：TCP 通但 TLS 握手失败同样判 dead
```

- **3 次并行取中位（v2.36.8）**：TCP/TLS 各 `probe3()` 并行 3 次，成功次数取延迟中位（丢最高丢最低），成败按多数票（≥2 成功才算通过）——单次抖动既不会把延迟打飞，也不会把活节点误判死。
- 并发控制：`PROBE_CONCURRENCY = 50`，分批 `Promise.all`；每段超时 `PROBE_TIMEOUT_MS = 3000`。
- 明文协议（ss / 无 tls 的 vmess 等）不做 TLS 握手（必然失败，不代表节点坏）。

**v2.38（P0）：UDP 协议节点基础探测不适用。**
hysteria2 / tuic / wireguard 基于 UDP，TCP 握手无意义，`probeNode` 早退返回
`status='unknown'`（不写 `health:latest` / `health:hist` / 状态机），避免 UDP 节点被 TCP 探测误杀。
`isProbeApplicable(protocol)` 判定：`UDP_PROBE_UNSUPPORTED_PROTOCOLS = {hysteria2, tuic, wireguard}`。

**P1 阶段 1 起**：基础探测不适用 ≠ 节点不可用。`getNodes()` **不再**按协议剔除 UDP 节点，
非锁定的 UDP 节点会正常进入生成的配置（详见 §5）。

结果写 `health:latest:{fingerprint}`（最新快照，覆盖写）+ `health:hist:{fingerprint}:{timestamp}`（时序，追加写，30 天清理）。
UDP 节点（`status='unknown'`）不写任何健康数据。

**三个独立代次键（阶段 2 / 评分代次 4 起）**：`resetProbeDataIfEngineChanged` **只同步版本号，不删除任何健康数据**。

| 键 | 初值 | 语义 | 变更时的动作 |
|---|---|---|---|
| `probe:score_version` | `4` | 评分公式代次 | **不清理任何数据** |
| `probe:schema_version` | `1` | 历史记录**字段结构**代次 | 仅当结构真正不兼容时才执行明确、可验证的迁移 |
| `probe:engine_version` | `4` | 探测方式代次（保留原键名与调用路径） | 保留键，兼容既有运维与测试 |

- **键缺失不等于历史结构不兼容**：新装环境、旧库首次升级、键被外部清除等场景一律只补写版本号，
  不清空 `health:hist:*` / `health:latest:*`。
- **升级不清历史的直接原因（安全要求）**：`getDroppedNodes()` 只读 `health:latest`，清空会让
  `statusMachine='disabled'` 的节点立刻重新进入生成的配置（需再连续失败 3 轮才被重新剔除），
  同时把状态机的连续失败计数一并归零。
- **行为变更（有意，非回归）**：连续失败计数**跨版本延续**。升级前已连续失败 3 轮的节点，
  升级后第 1 轮即 `disabled` 并被剔除。这是可用性保护。
- 状态机读取**全部保留历史**（`evaluateStateMachine` 不按时间窗口过滤），且只统计「最新一段连续同状态」：
  一旦遇到异状态即中断计数。因此当历史中「最新一轮 alive、其前一条 dead」时，结果为 `suspect`；
  即使再补一条 alive（连续 2 条成功），由于更早的 dead 仍在，结果**仍为 `suspect`**（详见 §2）。
- 该函数**只在探测轮次内惰性触发**（`doProbeAllNodes` 开头），无启动时调用。

### 1.1 历史时间戳有效性规则（评分与状态机共用）

评分（`calculateScore`）与状态机（`evaluateStateMachine`）消费历史前，
统一走 `isValidHistoryTimestamp(h, now)`（阶段 2 / R1 修复），排除：

- `timestamp` 字段缺失 / `undefined` / `null`（**不做隐式转换**，数字字符串同样无效）
- `NaN`、`Infinity`、`-Infinity`
- `timestamp <= 0`（含 `0` 与负数）
- **超出容差的未来时间戳**：`timestamp > now + FUTURE_TS_TOLERANCE_MS`，
  容差为 **5 分钟**（`FUTURE_TS_TOLERANCE_MS`，集中定义，不在两条链路各自硬编码），
  用于容忍轻微时钟偏差。

要点：

- 两条链路使用**同一时间参考值**（`doProbeAllNodes` 每轮取一次 `now` 同时传入），保证对同一条历史判断一致。
- 无效记录在计算时**被忽略**（不参与评分样本、不参与连续状态计数），**不会被改判为 alive/dead**。
- 校验**不改变**状态机阈值（dead ≥ 3 / dead ≥ 1 / alive ≥ 2）、排序方向（降序）与「遇异状态即停止计数」语义。
- 评分原有历史窗口规则不变；未来时间戳过滤**不是**窗口的扩大或缩小。
- **本阶段不会从数据库中删除无效记录**：`cleanupOldHistory` 的清理逻辑未改动，
  时间戳为 `0` 或不可解析的键仍不会被清理（已知遗留项，待单独授权）。

## 2. 状态机（熔断）

| 触发 | 动作 |
|---|---|
| 连续 1 次失败 | 标 `suspect`（观察，不剔除） |
| 连续 3 次失败 | 标 `disabled`（确认失效，进配置剔除，UI 标 🚫 置灰） |
| 最新连续 2 次成功（且此前无 dead 记录） | 恢复 `active` |

- **v2.38（P0-2 修复）：计入本轮再评估。** 原实现第 N 轮只评估前 N-1 条历史，导致 3 轮 dead 后
  仍为 suspect、第 4 轮才 disabled，与文档「连续 3 次 → disabled」差一轮。
  修复后 `doProbeAllNodes` 把本轮结果并入历史再交给 `evaluateStateMachine`，3 轮 dead 即 disabled。
- 成功（alive）打断连续失败计数后需重新累计 3 轮。
- **`active` 的实际可达条件（实现现状，见 §1 注）**：`evaluateStateMachine` 先判 `consecutiveFail>=1 → suspect`、
  再判 `consecutiveSuccess>=2 → active`。由于计数遇到异状态即中断，只要**传入的历史数组中还存在任何一条 dead**
  （无论其新旧），或本轮探测仍失败，结果就恒为 `suspect`，不会回到 `active`；`active` 仅在历史全为 alive 时出现。
  `suspect` 同样进配置，不影响筛选结果。该判定顺序属现状，是否调整**待业务规则确认**。
- 死节点永不物理删除——每次全量重测；节点可达后不再计入 dropped（状态回落至 `suspect` 或 `active`）。

## 3. 四维评分（阶段 2 / 评分代次 4）

```
Score = Math.max(0, Math.min(100, Math.round(
          (availability × wAvail + latency × wLat + tls × wTls + stability × wStab) × 100)))
```

| 维度 | 权重（TLS 适用） | 计算 |
|---|---|---|
| availability | 0.35 | 窗口内 `status==='alive'` 的历史条数 / N；**N=0 → 0.5**。本轮探测**不计入** |
| latency | 0.30 | 有效样本 S 的**中位数**：`max(0, 1 − median(S)/1000)`；样本不足 3 条 → 0.5 |
| TLS success | 0.25 | `(历史 tlsLatency 有效的条数 + 本轮是否有效) / (N + 1)`；非 TLS 协议整维剔除 |
| stability | 0.10 | 同一 S 的变异系数 CV：`\|S\|=0` → 0；`1–3` → 0.5；`≥4` → `1 − min(CV, 1)` |

- **有效延迟样本 S** = 历史 `status==='alive'` 且 `nodeLatencyMs(h)` 为**有效有限数值**的记录
  ∪（本轮探测 alive 且延迟有效时的本轮样本）。`nodeLatencyMs` 取 TLS RTT 优先、否则 TCP RTT；
  **NaN / ±Infinity / null / undefined / 缺失字段一律不作为有效样本**。
- **CV** = `样本标准差（分母 n−1） / 均值`；`mean === 0` 时 CV 按 0 处理（稳定性 = 1）；
  mean 非有限时稳定性取 0.5。
- **统计窗口** = 设置页 `sub_update_interval`（1-24h），`resolveWindowHours` 读取，缺失/非法回退 24。
- **时间过滤**：仅接受 `timestamp` 为有限数且 `> 0` 的记录，再按窗口过滤，最后按 timestamp 降序
  ——聚合结果与历史输入顺序**无关**。
- **Q1 归零例外（阶段 2 业务规则）**：本轮探测失败（TCP 不通 / TCP 通但 TLS 握手失败 /
  非 TLS 节点 TCP 不通）**且**窗口内不存在任何 `alive` 记录 → 评分直接为 `0`。
  只要存在 alive 历史证据，本规则不介入。
- **非 TLS 节点权重归一化**：`wTls = 0`，其余三维按**生产表达式**归一
  （`sum = 0.35 + 0.30 + 0.10 = 0.7499999999999999`，**不是字面 `0.75`**）：
  `wAvail = 0.46666666666666673`、`wLat = 0.4`、`wStab = 0.13333333333333336`（权重和恰为 1）。
  实测参考：非 TLS 冷启动存活 = `50`；非 TLS 有 3 条全 alive 历史 + 本轮存活 = `94`；
  非 TLS 有 3 条 alive 历史但本轮失败 = `69`。
- **冷启动 TLS 实测**：无历史 + 本轮 TCP/TLS 均成功 = `63`；
  无历史 + 本轮失败 = `0`（Q1 例外），非 `32`。
- **稳定性不再读取 `history.score`**：旧公式的评分自引用已移除。`history.score` 字段仍随记录落盘
  （兼容既有历史结构），但评分公式不读取它——改变 `history.score` 不影响评分结果。
- 节点全死 → 列表空也显示空（不填占位）。

## 4. 触发时机

| 触发点 | 行为 |
|---|---|
| 订阅自动更新（runScheduled） | 跑完自动 `probeAllNodes`（后台，不阻塞） |
| `POST /api/subscriptions/:id/update` | 完成后 `waitUntil` 触发 |
| `POST /api/subscriptions`（新增） | 建完 `waitUntil` 触发 |
| 节点列表页「⚡立即连通性探测」 | `POST /api/nodes/probe` 手动触发 |

`probeAllNodes` 返回 `{ total, alive, dead, unknown, suspect, disabled, avgLatency, minLatency }`；
**v2.38 新增 `unknown` 计数**（UDP 不适用节点数）。
列表页顶部常驻「存活 / 不通 / 不适用 / 已抛弃 / 上次探测时间」，完成弹统计 toast。
测活完成统一落操作日志（`logProbe`），手动/订阅刷新/自动更新 4 个入口一处全覆盖。

**并发门闩（v2.38）**：`probeAllNodes` 加 `probeAllNodesInflight` 单飞，重复调用排队等当前轮完成后
作为独立新一轮，避免并发重复写历史导致状态机误计数。

## 5. 抛弃判定（getDroppedNodes，P1 阶段 1 起仅「状态机确认失效」）

**P1 阶段 1 起：只保留「状态机确认失效」一条剔除规则。**

- **规则①：状态机确认失效（`statusMachine === 'disabled'`）** → 剔除。
  单轮 dead（suspect）**不剔除**；需连续 3 轮独立失败确认后才剔除。
  原 v2.36「最新一轮 dead 即剔除」已废弃（单轮抖动会误杀）。
- **规则②（已删除）**：原「慢节点」硬剔除（`node_drop_latency_ms` 阈值 + 最近 3 条历史 ≥2 条超阈值）
  已从 `getDroppedNodes()` 移除。理由：TCP/TLS 握手延迟 ≠ 代理实际转发延迟，不应据此剔除节点。
  延迟数据仍用于健康统计与列表排序展示。
- **UDP 协议不再从配置剔除**：`getNodes()` 已移除 `!isProbeApplicable(protocol)` 过滤。
  基础探测不适用 ≠ 节点不可用。
- **锁定节点（locked）全部豁免**：无视测活/禁用判定与 `removed_at`，强制进配置（v2.36.9）。
- **UDP 节点**：`status='unknown'` 不写健康数据 → 规则①不触发 → 保留。
- **suspect 死节点**（连续 1-2 轮 dead，未确认）：规则①不触发 → 保留（观察中）。

过滤链（`src/services/config.service.ts` `getNodes()`）：
`locked 豁免 → disabled（用户禁用）→ dropped（状态机 disabled）→ removed_at`。
不存在「状态机已确认失效却被另一规则放行」的矛盾。

## 6. 自动命名（smartRename，替代旧清洗）

```
格式: [旗帜][国家代码] [协议]-NN
例:  🇭🇰 HK VLESS-01
     🇯🇵 JP VLESS-02
```

- 旗帜+代码来自 ip-geo 缓存（复用地理分组同一数据源），同时把国家码写回 `metadata.country`。
- 延迟**不写进名字**（v2.36 定）——名字每次测活都变会让客户端视为新节点；延迟只在列表「连通性延迟」列展示。
- 重名自动追加 `-01`/`-02`（批次连续序号）。
- 命名只在**输出/展示**时发生：① `generate()` 内；② `/api/nodes` 走 `config.autoNamed()`（返回副本，不动库中原始名）。
- 旧清洗规则（clean-rule）已全量删除（v2.35.0）。

## 7. 地理组排序

`mihomo.ts` 生成 geoChoices 时，组内节点按最新快照 `health:latest` 的 `score` 降序。
自动选择组优先命中最优节点；死节点已 filter 不影响。
只影响配置输出，不影响 UI 列表（UI 排序前端独立处理）。

**v2.38（P0 选组优化）**：顶层「自动选择」url-test 候选从地区组/负载均衡组改为**扁平直接测节点**
（`allGeoNodes`），不再嵌套 url-test。地区组/LB 组保留各自 url-test/load-balance 参数，供手动与业务组引用。
测速 URL 全部 `http://` → `https://www.gstatic.com/generate_204`。
加密货币组 `default-selected` 从硬编码 `🇹🇼 台湾` 改为派生：有台湾组用组名，无则回落 `自动选择`。

## 8. 数据模型

```
node（现有，扩展）
├── original_address   ← 首次入库原始订阅地址（永久保留）
├── first_seen_at      ← 首次入库时间
└── status             ← active / suspect / disabled / removed（tombstone）

health:latest:{fingerprint}   ← 最新快照，覆盖写
├── fingerprint, timestamp
├── tcp_latency, tls_latency (ms | null)
├── status (alive | dead | timeout | error | unknown)
├── tlsApplicable (boolean)   ← v2.38：UDP 节点 false
├── error (string | null)
├── score (0-100)
└── statusMachine (active | suspect | disabled)

health:hist:{fingerprint}:{timestamp}   ← 时序，追加写，30 天清理
└── 同 latest 字段

probe:engine_version  ← "4"  探测方式代次
probe:score_version   ← "4"  评分公式代次（变更不清数据）
probe:schema_version  ← "1"  历史记录结构代次（仅在结构真正不兼容时才允许迁移）
```

**去重键**：`nodeFingerprint(server:port:protocol)`——同指纹只更新字段，保留 `original_address`。

**`history.score` 语义（阶段 2 起）**：字段仍随每条历史记录落盘（兼容既有结构），
但**评分公式不再读取它**——「稳定性」维度改为在有效延迟样本 S 上计算变异系数。
`health:latest.score` 仍被 API（`/api/nodes`、`/api/nodes/health`）与 Mihomo 组内排序消费。

## 9. UI 节点列表

| 列 | 内容 | 交互 |
|---|---|---|
| 连通性延迟 | 最新 TCP/TLS 握手 RTT（UDP 节点显示「不适用」） | 点击排序（升/降） |
| 状态 | alive / dead / timeout / error / 不适用 / 🚫 已抛弃 图标 | 点击弹历史趋势折线 |
| 操作 | 「⚡立即连通性探测」 | 触发全量探测 |

- **v2.38 前端口径**：列标题「延迟」→「连通性延迟」；tooltip 明确「TCP/TLS 握手 RTT，非真实代理延迟」；
  UDP 协议节点（hysteria2/tuic/wireguard）延迟列显示「不适用」、状态列显示 🚫、得分列显示「不适用」。
  `probeApplicable` 字段由 `/api/nodes` 返回（`isProbeApplicable(protocol)`）。
- 默认排序 `defaultNodeOrder`：国家码分组 → 评分降序 → 延迟升序 → 未识别国家排最后。
- 已抛弃节点不隐藏，标 🚫 置灰，顶部显示抛弃计数。