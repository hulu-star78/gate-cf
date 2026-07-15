cat > /usr/local/bin/gen-link.sh << 'EOF'
#!/bin/sh
CONFIG="/etc/xray/config.json"

# 提取参数
UUID=$(grep -o '"id": "[^"]*"' "$CONFIG" | head -1 | cut -d'"' -f4)
PORT=$(grep -o '"port": [0-9]*' "$CONFIG" | head -1 | awk '{print $2}')
SNI=$(grep -o '"serverNames": \[[^]]*\]' "$CONFIG" | grep -o '"[^"]*"' | head -1 | tr -d '"')
PBK=$(grep -o '"publicKey": "[^"]*"' "$CONFIG" | head -1 | cut -d'"' -f4)
SERVER_IP=$(curl -s ifconfig.me)

# 如果没提取到公钥，提示手动生成
if [ -z "$PBK" ]; then
    echo "错误: 未找到 publicKey，请先运行 'xray x25519' 生成并添加到配置中"
    exit 1
fi

# 生成链接
LINK="vless://$UUID@$SERVER_IP:$PORT?security=reality&encryption=none&flow=xtls-rprx-vision&fp=chrome&sni=$SNI&pbk=$PBK&type=tcp&headerType=none#MyVLESS"

echo "$LINK"
EOF