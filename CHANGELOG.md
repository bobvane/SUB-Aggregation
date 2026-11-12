# 更新日志

## v2.46.1 — 2026-11-12

依赖安全升级与仓库整理，无功能变更。

- 生产依赖升级：`hono` 4.13.8 → **4.13.18**、`@hono/node-server` 2.1.1 → **2.1.3**，修复 `serveStatic` 路径二次解码问题（本项目未使用该 API，属预防性升级）。
- 构建依赖升级：`vite` 7.3.6 → **7.3.8**；通过 `overrides` 强制 `source-map-js` 到 **1.2.2**。
- 升级后 `npm audit --omit=dev` 为 **0 vulnerabilities**；剩余的 `npm audit` 告警全部落在构建期 `devDependencies`（`@vitest/mocker`、`minimatch` / `brace-expansion` 链条），不进运行镜像，运行容器内只有单个 `dist/server.mjs`。
- 仓库整理：删除 19 个历史分支（`release/v2.38.4`~`v2.38.9`、`chore/*`、`fix/*`、`feat/*` 及 4 个 Dependabot 分支），关闭对应的自动化 Pull Request，工作流统一为「本地开发 → 推送 main → 打 tag 发版 → NAS 拉取镜像」。
- 新增 `.github/dependabot.yml`：依赖更新改为每月一次、按生产/开发分组，减少重复 PR 噪音。

## v2.46.0 — 2026-11-12

出网代理模型重写为「5 个目标 × 3 态」，目标是零配置无感可用。

- 代理策略从「用途勾选 + 模式」改为 **5 个目标 × 3 态**：目标为订阅拉取、规则目录同步、版本检查、域名解析、IP 归属；每项可单独设为「自动 / 代理 / 直连」。
- 「自动」的语义统一为 **先直连、不通再走代理**：直连探测只等 3 秒（`PROXY_PROBE_TIMEOUT_MS`，只约束握手 + 收到响应头，拿到响应头就按完整业务超时下载 body）；两路都失败时错误信息合并展示「直连失败：X；代理也失败：Y」。
- 代理地址即总开关：**填了才走代理，留空 = 全部直连**。全新部署无需任何配置就能用，网络通顺的 VPS 不必进设置页。
- bypass 优先级最高、一票否决：命中绕过列表的地址始终直连，即使该目标选了「代理」。理由是不走代理本就更快，且内网地址走代理多半不通。
- 不做负缓存：订阅 24h、目录同步每月、DoH 6h、IP 归属 30 天，出网间隔极长，缓存「哪个目标失败」没有收益，且会让用户改完设置后仍看到旧结论。
- 设置页「网络代理」重做为三段：① 代理地址（协议 + IP + 端口，端口预设 7893/7890/7891，「测试代理」按钮在地址右侧，带账号密码或域名代理时可切「高级」直接编辑完整地址）② 使用代理节点（5 行三态单选 + 每个目标的代价提示）③ 绕过代理地址（输入框 + 7 个可点击标签，点击加入或移除，也可手工输入）。
- 保存只提交用户真正改动过的字段；脱敏后的地址（`user:***@`）不会再被回存成真实配置；地址格式在前端先校验一次。
- 「测试代理」固定走代理，不受目标策略和 bypass 影响，只回答「这个代理地址本身通不通」。
- 移除单条订阅的 `useProxy` 覆盖：订阅抓取策略统一由设置页「订阅拉取」控制，订阅表单里的代理下拉框与列表中的代理徽标一并删除，改为一行说明。
- 存储键收敛为 `proxy_url` / `proxy_targets` / `proxy_bypass`；旧的 `proxy_mode`、`proxy_scope`、`proxy_fallback` 在启动时一次性迁移（`github` 拆为规则目录同步 + 版本检查，`geo` 拆为域名解析 + IP 归属，`mode=off` 迁移为 5 项全直连），迁移后不再读写。
- `GET /api/settings` 不再返回 `proxy_raw` / `proxy_effective`，改为 `proxy_url`（脱敏）+ `proxy_targets`（补全默认）+ `proxy_bypass` + `proxy_meta`（目标清单、预设标签、内置默认、探测时限由后端下发，避免前后端各写一份）。
- 未改变的部分：节点测活与测速始终裸 TCP/TLS 直连，不经过任何代理。
- 顺带清理：删除订阅代理覆盖相关的前后端代码与测试、设置页失效的函数与 DOM、`ip-geo.service.ts` 中零调用的单 IP 查询备用实现（`batchQuery` 设计上明确不降级单查，真正的备用链路是 DoH 双端点）。
- 本次为代理体系的成体系重构，未引入不兼容的存储格式（旧配置自动迁移），按 MINOR 递增。

## v2.44.3 — 2026-11-11

- 代理配置收敛为单一入口：移除「跟随环境变量」模式，设置页只保留「直连 / 手动指定代理地址」；运行时不再读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`。
- `.env.example` 与 `docker-compose.yml` 删除三项代理变量，代理地址只在面板「设置 → 网络代理」配置，避免两处配置产生歧义。
- 升级迁移：首次启动若检测到旧 `proxy_mode=env`，或从未保存模式但存在可用的环境变量代理，自动导入为 `manual` + 代理地址并打印日志；旧 env 模式无可用地址时回退直连。
- `NO_PROXY` 与内置 bypass 列表完全重复，已随环境变量代理一起移除；设置页 bypass 仍会与内置列表合并。
- `GET /api/settings` 移除 `proxy_env_detected` 与 `proxy_effective.env_detected` 字段，设置页同步删除环境变量提示。
- 未改变既有策略：节点测活/测速始终直连；订阅抓取默认直连；仅「代理失败 → 回退直连」，直连失败不回退代理。

## v2.44.2 — 2026-11-10

- 网络代理用途收敛：默认只让 GitHub 规则库同步与地理查询走代理，订阅抓取默认强制直连（无需代理，手机/直连环境可直接拉取），消除「Fetch timeout」误判。
- 订阅抓取超时由 10 秒放宽到 30 秒：境外大订阅不再轻易超时失败；修复 `fetcher.ts` 超时常量命名错误（`SUBSCRIPTION_SUBSCRIPTION_FETCH_TIMEOUT_MS` 误写，导致实际超时逻辑引用未定义符号）并统一两处常量。
- 回退策略修正：直连失败的用途不再回退到代理（只有代理失败才回退直连），避免「我只想给 GitHub 走代理」却让订阅因代理不可达而失败；`subscription` 用途默认直连且 `useProxy='off'` 可强制裸连。
- 设置页「网络代理」持久化修复：GET 拆分「原始存储值 / 生效值 / 环境变量检测」，表单只回显原始值；保存只提交用户实际改动过的字段（脏字段），杜绝 env 带密码保存 400、scope/bypass/mode 被固化、直连模式清空已存地址等问题。
- 新增环境代理按用途收窄能力：env 模式不再强制作用于全部用途，用户在设置页可单独勾选 GitHub / 地理 /（可选）订阅抓取。
- 侧栏与登录页左下角版本号改为读取 `/api/meta`（单一来源 `package.json`），并加 `Cache-Control: no-store`，升级镜像后浏览器不再渲染旧版本号。
- 新增订阅超时常量一致性、代理回退策略、设置页 GET→PUT 回环、版本号展示等回归测试。
- 本次为代理策略与设置持久化的常规修复，未引入不兼容变更，按 PATCH 递增。

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
