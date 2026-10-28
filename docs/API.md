# HTTP API

路由定义在 `src/api/routes.ts`。除健康检查、元信息、登录及带订阅 token 的 `/sub` 外，管理接口使用会话认证。成功响应通常为 `{ "success": true, "data": ... }`；错误由中间件统一返回 `{ "success": false, "error": { "code", "message" } }`。

## 路由索引

| 范围 | 路径 | 用途 |
|---|---|---|
| 元信息 | `GET /api/health`, `/api/meta`, `/api/meta/check-upgrade` | 健康状态、应用信息和版本检查 |
| 认证 | `/api/auth/*` | 登录、登出、会话、用户名和密码 |
| 订阅 | `/api/subscriptions`、`/api/subscriptions/:id/*` | 列表、新增、编辑、删除、启停、更新 |
| 节点 | `/api/nodes*` | 节点列表、启停、锁定、探测、健康和 GeoIP |
| 规则 | `/api/rules*` | 自定义规则、固定组、目录和选择状态 |
| 配置 | `GET /api/output/:format` | 管理界面预览/下载生成配置 |
| 设置与日志 | `/api/settings`、`/api/operation-log` | 应用设置及操作日志 |
| 客户端订阅 | `GET /sub/:format/:token` | 通过长随机 token 获取订阅配置 |

路由完整列表、参数校验和各端点的认证要求以 `src/api/routes.ts` 为准。修改 API 时同步更新浏览器端 `public/api.js`、相关集成测试和本页。

仪表盘数据包含 `failedSubscriptions`，表示启用且最近一次更新失败的订阅数，供首页关注概览定位问题。

`GET /api/meta/check-upgrade` 在页面打开或刷新时从 GitHub Releases Atom 源读取版本；该接口及浏览器请求均禁用缓存。GitHub 不可达时返回 `checked: false`，前端应显示暂时无法检查。

## 认证与敏感信息

- 管理端使用 `sub_session` HttpOnly Cookie；会话默认 7 天，改密码后旧会话失效。
- `/sub/:format/:token` 的 token 等同密码，不要写入日志、截图或公开工单。
- 反向代理需正确传递 `X-Forwarded-Proto`，HTTPS 请求才会设置 `Secure` Cookie 属性。
