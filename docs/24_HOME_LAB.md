# 24 · 家宽实验（独立模块）

> 版本：v2.50.9 起。**实验功能**，与节点列表 / 输出配置 / WARP 实验页完全隔离。

## 1. 目的

从 **VPN Gate** 的免费中继列表拉取节点，做两件事：

1. **端口连通**：测试中继的 TCP 端口是否可达；
2. **住宅评分**：用 ip-api + ipapi.is 的 ASN/ISP/hosting/mobile 等信号，
   给出 `住宅 / 疑似住宅 / 机房 / 代理 / 未知` + 置信度 + 理由。

页面只负责「看和测」，不把节点并入项目主链路。

## 2. 隔离约定（重要）

本模块**只**读写以下 KV 键：

- `home_lab:settings`（总开关、源地址、间隔、上次拉取/错误）
- `home_lab:nodes`（解析后的中继列表）
- `home_lab:intel:<ip>`（IP 情报缓存，7 天 TTL）

不写入、不读取：

- `nodes:*` / `health:*` / `settings:*`
- 输出配置、代理组、国家组、调度任务
- WARP 实验页的 `warp_lab:*`

因此删除本页（导航、页面、JS、路由、服务）后，项目回到原状。

## 3. 数据来源

VPN Gate 公开 CSV：

```
https://www.vpngate.net/api/iphone/
```

字段：

```
HostName, IP, Score, Ping, Speed, CountryLong, CountryShort,
NumVpnSessions, Uptime, TotalUsers, TotalTraffic,
LogType, Operator, Message, OpenVPN_ConfigData_Base64
```

- 从 `OpenVPN_ConfigData_Base64` 解出 `.ovpn`，提取 `remote IP port` 与 `proto tcp/udp`；
- 按 `CountryShort` 支持国家筛选；
- 单次最多保留 300 个中继，按 `Score` 截断。

## 4. 住宅评分

先调 **ip-api.com** 批量接口：

```
status,country,countryCode,isp,org,as,asname,mobile,proxy,hosting,query
```

再对前 60 个未缓存 IP 调 **ipapi.is** 做二次确认：

```
is_datacenter,is_vpn,is_proxy,is_tor,company.type,asn.type
```

判定顺序（命中即停）：

| 条件 | 结果 |
|---|---|
| `is_datacenter=true` / `hosting=true` / `company.type=hosting` | 机房（90%+） |
| `is_vpn` / `is_proxy` / `proxy=true` | 代理/VPN（85%） |
| `mobile=true` | 住宅（80%） |
| 主机名 `public-vpn-*` | 机房（70%） |
| ASN 属于常见机房列表 | 机房（75%） |
| ISP/AS 命中机房关键词 | 机房（72%） |
| ISP/AS 命中家宽关键词 | 疑似住宅（65%） |
| 没有足够信号 | 未知（0-25%） |

> 与 xehn 的区别：xehn 在没有信号时默认 `residential`；本页判 `unknown`，避免虚高。

## 5. 调度

- 总开关关闭：`maybeFetchHomeLab` 直接返回，不拉取；
- 开启后：由项目每分钟 cron 调用，按 `intervalHours`（默认 12 小时，可选 6/12/24/48）判断是否到点；
- 用 `lastAttemptAt` 防抖：失败后不会每分钟重试；
- 手动「立即拉取」不受间隔限制。

## 6. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/home-lab/status` | 设置 + 中继列表 + 默认值 |
| POST | `/api/home-lab/settings` | 更新总开关 / 源地址 / 间隔 |
| POST | `/api/home-lab/fetch` | 立即拉取（敏感操作限流） |
| POST | `/api/home-lab/test` | 测试单个中继的端口连通 |
| POST | `/api/home-lab/test-all` | 测试全部（并发 12） |
| POST | `/api/home-lab/clear` | 清除设置、列表、情报缓存 |

## 7. 当前限制

- v1 只做 **TCP 端口可达**；真正的 OpenVPN 隧道/握手/测速后续再加。
- VPN Gate 中继质量参差、寿命短；建议间隔 12 小时以上。
- 「住宅」是启发式评分，不是 100% 证明；页面会显示置信度与理由。
- 免费情报接口有额度/限流；失败时保留 ip-api 结果，不阻塞列表。

## 8. 移除方式

1. `public/index.html`：导航 `data-page="home-lab"`、`#page-home-lab`、`loadHomeLab` 等 JS、`pageLabels` 与命令面板条目。
2. `src/api/routes.ts`：`/api/home-lab/*` 路由与 import。
3. `src/services/home-lab.service.ts`。
4. `src/app.ts`：`* * * * *` cron 里的 `maybeFetchHomeLab` 调用。
5. `tests/services/home-lab.test.ts`。
6. 运行 `npm run build:html`，删除残留的 `home_lab:*` 键（或先在页面点“清除”）。
