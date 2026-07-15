# CF-Worker Relay + VPNGate 出口面板

一套基于 **Cloudflare Workers（免费计划）** 的 vless+ws+tls 中转方案，配合自有 **VPS** 运行 Xray，VPS 出口走 **VPNGate 公益节点**。自带 Web 后台（ADMIN + KEY → 生成 UUID → 订阅 TOKEN），并对外提供自适应订阅（v2rayN 直接订阅）。

## 架构

```
v2rayN (vless+ws+tls)
   │  wss://<worker>.<sub>.workers.dev/vless
   ▼
Cloudflare Worker   ← 免费计划，WebSocket 纯透传 + 管理/订阅面板（KV 存用户）
   │  ws://<vps-ip>:<port>/vless   （或 wss://，见下文安全说明）
   ▼
VPS : Xray vless+ws 入站（按 UUID 鉴权）
   │  默认路由 → tun0
   ▼
VPNGate 公益 OpenVPN 节点  →  互联网
```

- **单一数据源**：用户在 Worker 后台创建，UUID/TOKEN 存在 Worker KV；VPS 通过 `/api/internal/users` 周期同步 UUID 到 Xray。
- **自适应订阅**：`/sub/<token>` 根据「当前访问的域名」自动生成 v2rayN 订阅链接，换域名/自定义域无需改配置。

## 目录

```
worker/    Cloudflare Worker 源码 + wrangler 配置
vps/       VPS 端 Xray / OpenVPN(VPNGate) / 同步脚本
```

## 一、部署 Cloudflare Worker

1. 安装 wrangler（已装 Node 后）：
   ```bash
   npm i -g wrangler
   wrangler login
   ```
2. 在 Cloudflare 控制台创建一个 KV 命名空间（例如 `cfrelay-users`），记下它的 **ID**。
3. 编辑 `worker/wrangler.toml`：
   - 把 `kv_namespaces.id` 换成你的 KV ID；
   - `VPS_TARGET` 改成你的 VPS `ws://IP:PORT` 或 `wss://域名:PORT`；
   - `WS_PATH` 保持 `/vless`（需与 VPS 端一致）。
4. 设置管理员密钥（**务必设置**，否则后台无密码）：
   ```bash
   cd worker
   wrangler secret put ADMIN_KEY      # 交互输入你的管理员密码
   ```
5. 部署：
   ```bash
   wrangler deploy
   ```

> 安全说明：Worker→VPS 这一段如果用 `ws://`（明文），链路内容仍被 vless 加密，仅 ws 头/路径可见；若要端到端再加一层 TLS，请给 VPS 配一个真实域名证书并用 `wss://域名:PORT`。

## 二、部署 VPS 端

在 VPS（推荐 Debian/Ubuntu）上：

```bash
# 1) 安装 Xray + OpenVPN
bash vps/setup.sh

# 2) 同步 Worker 上的 UUID 到 Xray（每次增删用户后执行一次）
WORKER_URL=https://<your-worker>.workers.dev ADMIN_KEY=<你的ADMIN_KEY> bash vps/sync-users.sh

# 3) 连接 VPNGate 公益节点作为出口
bash vps/vpngate.sh
```

`vpngate.sh` 会拉取 VPNGate 节点列表，按评分挑一个支持 OpenVPN 的节点，写入 `/etc/openvpn/vpngate.ovpn` 并后台连接。
VPNGate 免费节点带宽/稳定性有限，脚本可反复执行切换节点。

## 三、使用

1. 浏览器打开 `https://<your-worker>.workers.dev/admin`，输入 `ADMIN_KEY` 登录。
2. 点「新建用户」→ 得到 `UUID`、`TOKEN`、订阅地址 `https://<your-worker>.workers.dev/sub/<token>`。
3. v2rayN：
   - 订阅 → 添加订阅链接，粘贴上面的 `/sub/<token>` 地址；
   - 或手动：添加 VMess/vless 服务器，协议 vless，地址填 Worker 域名，端口 443，UUID 填后台给的，传输 ws、路径 `/vless`、TLS 开启、SNI 填 Worker 域名。
4. 增删用户后，到 VPS 再跑一次 `sync-users.sh` 让 Xray 生效。

## 备注 / 限制

- **免费计划限制**：Workers 免费版每日 10 万次请求、CPU 按实际执行时间计费（透传主要是等待 I/O，占用极小）。高流量或长连接多时可能触限，必要时升级 $5/月套餐。
- **VPNGate 公益节点**：由志愿者提供，速度/可用性不稳定、单节点有流量与并发限制，适合轻量自用；生产/稳定需求建议换付费 VPN 或自有出口。
- **出口路由**：VPNGate 连上后默认全量走 `tun0`；如只想让代理流量走 VPN，可在 VPS 上做策略路由（按 Xray 的出口 marks 分流），此处从简。
