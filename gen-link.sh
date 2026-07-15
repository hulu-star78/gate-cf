cat > /usr/local/bin/gen-link.sh << 'EOF'
#!/bin/sh
CONFIG="/etc/xray/config.json"

UUID=$(grep '"id":' "$CONFIG" | head -1 | sed 's/.*"id": "\([^"]*\)".*/\1/')
PORT=$(grep '"port":' "$CONFIG" | head -1 | sed 's/.*"port": \([0-9]*\).*/\1/')
SNI=$(grep '"serverNames":' "$CONFIG" | head -1 | sed 's/.*"serverNames": \[[ ]*"\([^"]*\)".*/\1/')
PBK=$(grep '"publicKey":' "$CONFIG" | head -1 | sed 's/.*"publicKey": "\([^"]*\)".*/\1/')
SERVER_IP=$(curl -s ifconfig.me)

if [ -z "$PBK" ]; then
    echo "错误: 未找到 publicKey"
    exit 1
fi

echo "vless://$UUID@$SERVER_IP:$PORT?security=reality&encryption=none&flow=xtls-rprx-vision&fp=chrome&sni=$SNI&pbk=$PBK&type=tcp&headerType=none#MyVLESS"
EOF

chmod +x /usr/local/bin/gen-link.sh
