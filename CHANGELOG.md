# 更新日志

## v2.44.1 — 2026-11-10

- 分流规则：社交组新增 `geosite:TWITTER` / `geosite:META`，加密货币组新增 `geosite:BINANCE` / `geosite:OKX`，均为组内点名固定规则（不可单独取消）、原生 `GEOSITE` 输出，排在各自聚合分类之前。
- `geosite:META` 归入社交策略组：Muse AI（`muse.ai`）已由 AI 平台组原有的 `category-ai-!cn` / `category-ai-chat-!cn` 聚合规则收录，且这两条规则排在 `GEOSITE,meta,社交` 之前，因此 Muse AI 仍走 AI 平台策略组；上游不存在独立的 `MUSE` 分类，故不新增 `geosite:MUSE`。
- 节点列表：移除第一列的锁定图标开关，改为操作列的「锁定 / 解锁」文字按钮（语义不变 —— 无视测活与延迟、强制进配置）。
- 节点列表新增「移出配置 / 恢复」按钮，手工选定节点不进入输出配置；新增单节点接口 `POST /api/nodes/excluded`、`GET /api/nodes` 的 `excluded` 字段，状态列显示「已移出」。
- 锁定与移出配置互斥：移出配置时自动解锁，锁定已排除节点时自动恢复，避免 `getNodes()` 的 `locked > disabled` 优先级让操作看起来无效；前端乐观更新并在保存失败时完整回滚。
- 节点自动命名的二字码改为中文国家名（`🇨🇦 CA VLESS-09` → `🇨🇦 加拿大VLESS-09`）；`metadata.country` 仍保留二字码，Mihomo 地区分组走纯 IP 定位，不受影响。
- 同步修正节点列表说明文案、命名格式说明与文档维护基线；新增节点排除接口与前端操作列的回归测试。
- 本次为规则与界面层的常规小更新，未引入不兼容变更，按 PATCH 递增。

## v2.44.0 — 2026-11-09

- 出网代理改为「按用途可选」：新增订阅抓取 / GitHub 升级与规则目录 / 地理查询三类用途，支持直连（默认）、环境变量、手动地址三种模式。
- 设置页新增「网络代理」卡片：代理模式、地址（密码脱敏）、用途勾选、绕过列表、失败回退和连通性测试；设置保存在项目设置（`app.db`）中。
- 单条订阅新增 `useProxy`（自动 / 强制代理 / 强制直连），可覆盖全局策略；自动模式支持代理失败回退直连、直连失败回退代理，超时不回退。
- 订阅抓取、升级检测、规则目录同步、DoH 解析与 ip-api 查询统一走 `src/engine/http-client.ts`；升级检测和目录同步补充 5 秒 / 15 秒超时。
- 网络错误改为递归展开完整 `cause` 链，代理 407 等深层原因不再只显示「Request was cancelled.」。
- 节点测活/测速保持裸 TCP/TLS 直连，新增隔离测试防止误接入 HTTP 代理。
- 移除 `docker-compose.yml` 中硬编码的个人代理默认值 `192.168.2.5:7890` 与 `NODE_USE_ENV_PROXY` 运行前提；不配置代理也能正常直连运行。
- 修复 `npm run build:server` 在 Windows 下因 banner 引号导致 esbuild 多输入文件报错的问题，改用跨平台 `scripts/build-server.js`。

## v2.43.1 — 2026-11-04

- 修复 VLESS-XHTTP 节点在 Mihomo / Clash Meta / OpenClash / Stash 中测速超时：生成器不再把 `encryption` 硬编码为 `none`，改为原样透传链接中的 VLESS Encryption（`mlkem768x25519plus.native.0rtt.<key>`，Xray v25+ / 3X-UI 加密入站必需）。
- 修复 XHTTP 传输丢弃 `flow=xtls-rprx-vision` 的问题：3X-UI 把 TCP 入站克隆为 XHTTP 时服务端会校验该字段，缺省会握手后被断开；现在 XHTTP 原样保留 `flow`，WS/gRPC 仍不输出。
- 从结构化模型回写 VLESS 链接时同样保留 VLESS Encryption，不再退化为 `encryption=none`。
- 新增 ML-KEM 透传、XHTTP `flow` 保留、WS 不输出 `flow`、加密链接回写的回归测试。
- 真机验证：`US VLESS-02` / `MY VLESS-02` 在 Mihomo v1.19.33 下测速分别约 671ms / 497ms，同机 TCP 节点亦正常。

## v2.43.0 — 2026-11-02

- 修复节点列表「锁定」点击后刷新失效：移除已删除的 `refreshNodeCount()` 调用，锁定状态现在会正常保存并在刷新后保留。
- 恢复 Mihomo / Clash Meta / OpenClash / Stash 的 VLESS-XHTTP 输出：`network: xhttp`、`xhttp-opts.path/host/mode`，并保留 REALITY、ECH、x-padding 与缺省 `alpn: [h2]`。
- 修复同一服务器、同一端口、同协议的 TCP 与 XHTTP 节点被误去重的问题：节点指纹对 XHTTP 追加 `:xhttp`，去重、锁定/禁用与健康数据统一使用同一指纹。
- XTLS `flow` 仅对 TCP 传输输出，避免 WS/XHTTP/gRPC 携带互斥的 Vision 参数。
- 修复发布门禁脚本的 shebang 导致 `tests/tools/release-audit.test.ts` 在 Vite SSR 下报 `SyntaxError` 的问题，全量测试恢复通过。

## v2.42.0 — 2026-11-02

- 按 sing-box 1.14/1.15 官方 schema 重写输出映射，修复配置无法加载的问题：
  DNS server 改用 `type: https/local` 新格式；tcp 节点不再输出无效 transport；gRPC 使用 `service_name`；h2 映射为 `http`。
- 修正协议字段：VMess `method → security`、Shadowsocks `ss → shadowsocks`、Hysteria2 `server_ports/up_mbps/down_mbps/tls`、TUIC 的 TLS 与 `zero_rtt_handshake`、AnyTLS 的 `tls` 与时长字符串。
- WireGuard 改输出顶层 `endpoints` + `peers`（sing-box 1.13 起已移除 wireguard outbound）；无法表达的 SSR、XHTTP、TUIC V4 节点会自动跳过，不再产生悬空引用。
- Base64 四格式补全 YAML 源重建字段：VLESS 的 `fp/spx/alpn/allowInsecure`、VMess 的 `sni/fp/alpn/allowInsecure`、Trojan 的 ws/gRPC 传输层与 TLS 参数；VMess 链接解析同步保留这些字段。
- 节点重名处理修复：`[X, X, X-1]` 不再生成两个 `X-1`，所有输出格式的名称保持唯一。
- 输出页二维码改为本地生成，订阅 token 不再发送给第三方服务；Base64 格式预览先解码再展示；下载失败时提示真实原因；Sing-box 从“纯链接”分组移入“完整配置”分组。
- 删除未使用且语法不符合 Shadowrocket/Surge 的 `shadowrocket.ts` 生成器及其测试。
- 新增 sing-box 官方 schema 字段一致性测试，覆盖全部支持的协议与 DNS / endpoint。

## v2.41.0 — 2026-10-28

- REALITY 节点输出 `reality-opts.support-x25519mlkem768: true`（链接显式 false/0 时尊重原值），修复 Xray 26.9.8+ 服务端因缺少 X25519MLKEM768 而认证失败的问题。
- 不再把 Xray 的 `spx` 写入 Mihomo `reality-opts`（Mihomo 不支持该字段），原始值仍保留在节点元数据中供链接回写。
- Clash/Mihomo YAML 订阅支持 `servername` 作为 SNI，并保留 `reality-opts` 中的 `spx` 与 `support-x25519mlkem768`。
- 自动命名改为每个国家码独立从 01 编号，节点增删不再导致其他国家节点整体重命名；锁定节点在本国组内优先拿小号。
- 编辑订阅修改链接并保存后自动拉取最新节点，不再需要手动再点「更新」。
- 新增 REALITY 字段映射、Clash YAML SNI、混合链接端到端输出与命名稳定性回归测试。

## v2.40.1 — 2026-10-28

- 订阅更新失败时展示真实失败原因，包括 DNS 解析、连接失败等底层网络错误，并恢复最近失败时间、重试次数和下次重试信息。
- 订阅管理新增「编辑」按钮，可修改订阅名称和链接；修改链接后会重置旧失败/重试状态，并提示点击「更新」重新拉取节点。
- 修复新增订阅后仍被「更新失败」等筛选条件隐藏、看起来像添加失败的问题。

## v2.40.0 — 2026-10-21

- 仪表盘增加订阅失败、不通节点和已抛弃节点的快捷入口，可直接跳到对应筛选结果。
- 订阅和节点列表增加搜索、状态/协议筛选、排序与结果计数，并在本机浏览器记住上次选择。
- 订阅失败状态更明确，展示重试暂停/下次重试信息，并提供立即重试入口。
- 统一成功与失败提示；长任务继续显示进度，失败信息提供下一步建议。
- 窄屏侧栏可折叠，订阅和节点宽表格可横向滚动。
- 提高正文、状态文字和表格字号及对比度，补充键盘焦点提示。

## v2.39.4 — 2026-10-21

- 每次打开或刷新页面时重新检查 GitHub 最新 Release；移除 6 小时成功缓存，并禁用浏览器及代理缓存。
- 检查失败时继续明确显示“暂时无法检查”，不误报为已是最新。

## v2.39.3 — 2026-10-21

- 订阅自动更新失败后安排 1、2、4 小时的有限重试；重试只请求失败的订阅，不重置常规更新间隔。
- 订阅列表显示最近失败原因、失败时间和下次重试时间；重试耗尽后提示可手动更新。
- 成功更新会清除失败信息与重试状态。

## v2.39.2 — 2026-10-21

- SQLite 前缀列表改用主键范围查询，避免 `substr()` 导致全索引扫描，并保持下划线、百分号和 Unicode 前缀的精确匹配。
- 健康历史记录写入 30 天过期时间；订阅更新成功后清除升级前遗留的过期历史，包括孤儿历史。
- DNS 缓存设置 6 小时过期，IP 归属缓存设置 30 天过期，避免 SQLite 键持续累积。

## v2.39.1 — 2026-10-19

- 按已选 Atlas 方案统一全站米白与森林绿配色、衬线标题、侧栏、顶部导航和开放式布局。
- 保留原有业务功能、交互、接口和数据逻辑；新增 Atlas 页面头部与面包屑。

## v2.39.0 — 2026-10-19

- 侧栏版本号增加 GitHub Releases 更新提示：发现新版本时显示红点，悬停可查看线上版本号，点击版本号打开对应 Release。
- 精简并重组项目文档，按架构、API、生成、规则、节点健康、部署、安全和维护分主题查阅。
- 统一应用、锁文件和文档维护基线版本。

历史版本的详细变更见 [GitHub Releases](https://github.com/bobvane/SUB-Aggregation/releases)。
