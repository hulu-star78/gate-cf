#!/usr/bin/env bash
# =============================================================
#  CF-Worker Relay - VPS 一键部署脚本（合并版）
#  功能：安装 Xray + OpenVPN → 从 Worker 同步 UUID → 连接 VPNGate 出口
#  适用：Debian / Ubuntu / RHEL / CentOS / Alma / Rocky / Alpine，以 root 运行
#
#  用法：
#    bash deploy.sh setup        # 安装依赖 + Xray + OpenVPN
#    bash deploy.sh sync         # 从 Worker 拉 UUID，生成 Xray 配置并重启
#    bash deploy.sh vpn          # 连接 VPNGate 公益节点作为出口
#    bash deploy.sh all          # 依次执行上面三步（推荐首次使用）
#
#  环境变量（不传则脚本会交互式询问）：
#    WORKER_URL   例如 https://xxx.workers.dev
#    ADMIN_KEY    Worker 后台管理员密钥
#    WS_PATH      ws 路径，默认 /vless
#    PORT         Xray 监听端口，默认 20554（需与 wrangler.toml 的 VPS_TARGET 端口一致）
# =============================================================
# 若用 sh/dash/ash 等非 bash 解释器运行，自动改用 bash 重新执行（脚本用到 bash 特性）
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  else
    echo "[-] 当前 shell 非 bash 且未找到 bash，请先安装：apk add bash / yum install bash，然后运行 bash deploy.sh"; exit 1
  fi
fi

set -euo pipefail

# ---------- 可调参数 ----------
WS_PATH="${WS_PATH:-/vless}"
PORT="${PORT:-20554}"
CONFIG="/usr/local/etc/xray/config.json"
OVPN_CONF="/etc/openvpn/vpngate.ovpn"
VPNGATE_API="http://www.vpngate.net/api/iphone/"

# ---------- 交互补充参数 ----------
ask_if_empty() {
  local var="$1" prompt="$2"
  if [ -z "${!var:-}" ]; then
    read -r -p "$prompt" "$var"
  fi
}

# ================= 安装依赖 =================
install_deps() {
  [ "$(id -u)" -eq 0 ] || { echo "请使用 root 运行"; exit 1; }

  # 自动检测包管理器（Debian/Ubuntu / RHEL/CentOS / Alpine）
  if command -v apt-get >/dev/null 2>&1; then
    PKG=apt
    apt-get update -y
    INSTALL="apt-get install -y"
  elif command -v dnf >/dev/null 2>&1; then
    PKG=dnf; INSTALL="dnf install -y"
    dnf install -y epel-release 2>/dev/null || true
  elif command -v yum >/dev/null 2>&1; then
    PKG=yum; INSTALL="yum install -y"
    yum install -y epel-release 2>/dev/null || true
  elif command -v apk >/dev/null 2>&1; then
    PKG=apk
    apk update
    INSTALL="apk add"
  else
    echo "[-] 未识别的包管理器，请手动安装：openvpn curl python3 ca-certificates"; exit 1
  fi

  echo "[*] 安装依赖（包管理器：$PKG）..."
  $INSTALL openvpn curl python3 ca-certificates

  if [ ! -x /usr/local/bin/xray ]; then
    echo "[*] 安装 Xray ..."
    bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
  fi
  mkdir -p /usr/local/etc/xray /etc/openvpn
  echo "[+] 基础安装完成。"
}

# ================= 同步 UUID 到 Xray =================
sync_users() {
  ask_if_empty WORKER_URL "请输入 WORKER_URL (例如 https://xxx.workers.dev): "
  ask_if_empty ADMIN_KEY  "请输入 ADMIN_KEY (Worker 后台密钥): "

  echo "[*] 从 Worker 拉取 UUID 列表 ..."
  TMP="$(mktemp)"
  curl -fsS "$WORKER_URL/api/internal/users?key=$ADMIN_KEY" -o "$TMP"

  UUIDS="$(python3 - "$TMP" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(json.dumps([{"id":u,"level":0,"email":u[:8]} for u in d.get("uuids",[])]))
PY
)"
  COUNT="$(echo "$UUIDS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')"
  echo "[*] 共 $COUNT 个用户"

  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<JSON
{
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": $PORT,
      "protocol": "vless",
      "settings": { "clients": $UUIDS, "decryption": "none" },
      "streamSettings": { "network": "ws", "wsSettings": { "path": "$WS_PATH" } }
    }
  ],
  "outbounds": [ { "protocol": "freedom", "tag": "direct", "settings": {} } ]
}
JSON

  echo "[*] 重启 Xray ..."
  if command -v systemctl >/dev/null 2>&1 && systemctl cat xray >/dev/null 2>&1; then
    if systemctl restart xray; then echo "[+] xray 已重启 (systemd)"; else echo "[!] xray 重启失败，请手动排查日志"; fi
  else
    pkill -f 'xray run' || true
    nohup xray run -config "$CONFIG" >/var/log/xray.log 2>&1 &
    echo "[+] xray 已后台启动，日志：/var/log/xray.log"
  fi
  rm -f "$TMP"
}

# ================= 连接 VPNGate 出口 =================
connect_vpn() {
  echo "[*] 拉取 VPNGate 节点列表 ..."
  python3 - "$VPNGATE_API" "$OVPN_CONF" <<'PY'
import sys, csv, base64, urllib.request
api_url, out_path = sys.argv[1], sys.argv[2]
data = urllib.request.urlopen(api_url, timeout=30).read().decode(errors="ignore")
rows = list(csv.reader(data.splitlines()))
if len(rows) < 2:
    print("[-] 未获取到节点，可能网络被墙，请换源或手动下载 .ovpn"); sys.exit(1)
header = rows[0]
idx = {h: i for i, h in enumerate(header)}
cands = []
for r in rows[1:]:
    if len(r) <= idx.get("#OpenVPN_ConfigData_Base64", -1): continue
    ovpn_b64 = r[idx["#OpenVPN_ConfigData_Base64"]]
    if not ovpn_b64: continue
    try: score = int(r[idx["#Score"]] or 0)
    except ValueError: score = 0
    cands.append((score, ovpn_b64))
if not cands:
    print("[-] 没有可用的 OpenVPN 节点"); sys.exit(1)
cands.sort(reverse=True)
best = base64.b64decode(cands[0][1]).decode(errors="ignore")
open(out_path, "w").write(best)
print(f"[+] 已写入配置：{out_path}（候选 {len(cands)} 个，已选评分最高）")
PY

  echo "[*] 连接 OpenVPN（后台守护） ..."
  if command -v systemctl >/dev/null 2>&1 && systemctl cat openvpn >/dev/null 2>&1; then
    cp "$OVPN_CONF" /etc/openvpn/vpngate.conf
    if systemctl restart openvpn@vpngate; then echo "[+] openvpn 已启动 (systemd)"; else echo "[!] openvpn 重启失败，请手动排查日志"; fi
  else
    pkill -f "openvpn --config $OVPN_CONF" || true
    nohup openvpn --config "$OVPN_CONF" >/var/log/vpngate.log 2>&1 &
    echo "[+] openvpn 已后台启动，日志：/var/log/vpngate.log"
  fi

  echo "[*] 当前出口 IP："
  curl -fsS https://api.ipify.org || echo "(无法获取，请稍候)"
}

# ================= 入口 =================
case "${1:-all}" in
  setup) install_deps ;;
  sync)  sync_users ;;
  vpn)   connect_vpn ;;
  all)
    install_deps
    sync_users
    connect_vpn
    echo; echo "[+] 全部完成。增删用户后只需再跑： bash deploy.sh sync"
    ;;
  *) echo "用法: bash deploy.sh [setup|sync|vpn|all]"; exit 1 ;;
esac
