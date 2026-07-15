/**
 * CF-Worker Relay
 * - WebSocket 透传（vless+ws+tls 客户端 -> VPS Xray）
 * - Web 后台：ADMIN_KEY 鉴权，创建/删除用户，生成 UUID + 订阅 TOKEN
 * - 自适应订阅：/sub/<token> 按当前访问域名生成 v2rayN 订阅
 * - 内部同步：/api/internal/users 供 VPS 拉取 UUID 列表
 *
 * 部署方式说明：
 *  A) wrangler deploy：变量来自 wrangler.toml（VPS_TARGET / WS_PATH / ADMIN_KEY 机密），KV 来自 [[kv_namespaces]]
 *  B) 控制台粘贴部署（本文件直接粘贴）：wrangler.toml 不生效！需要：
 *       - 在 Worker「设置 → 变量 → 环境变量」添加 VPS_TARGET、WS_PATH（可选，已有下方默认值）、ADMIN_KEY（机密）
 *       - 在 Worker「设置 → 变量 → KV 命名空间绑定」把命名空间绑定到变量名 KV
 *     下方已为 VPS_TARGET 提供默认值，粘贴后只要绑定 KV + 设 ADMIN_KEY 即可运行。
 */

const DEFAULT_WS_PATH = '/vless';
// 粘贴部署时若控制台未单独设 VPS_TARGET，则用此默认值
const DEFAULT_VPS_TARGET = 'ws://vps ip:20554';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 后台页面与 API
    if (path === '/admin' || path.startsWith('/api/')) {
      return handleAdmin(request, env, url);
    }
    // 订阅
    if (path.startsWith('/sub/')) {
      return handleSub(request, env, url);
    }
    // WebSocket 透传（仅放行指定路径，避免被滥用）
    const wsPath = (env.WS_PATH || DEFAULT_WS_PATH);
    if (request.headers.get('Upgrade') === 'websocket' && path === wsPath) {
      return handleRelay(request, env);
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      return new Response('forbidden ws path', { status: 403 });
    }
    // 落地页
    return new Response(
      'CF-Worker Relay + Panel\n访问 /admin 进入后台，/sub/<token> 获取订阅。',
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
};

/* ---------------- WebSocket 透传 ---------------- */
async function handleRelay(request, env) {
  const target = (env.VPS_TARGET || DEFAULT_VPS_TARGET).replace(/\/+$/, '');
  const url = new URL(request.url);
  const upstreamUrl = target + url.pathname + url.search;

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.binaryType = 'arraybuffer';

  try {
    const upstream = new WebSocket(upstreamUrl);
    upstream.binaryType = 'arraybuffer';

    server.addEventListener('message', (e) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(e.data);
    });
    upstream.addEventListener('message', (e) => {
      if (server.readyState === WebSocket.OPEN) server.send(e.data);
    });
    const closeBoth = () => {
      try { if (server.readyState === WebSocket.OPEN) server.close(); } catch (_) {}
      try { if (upstream.readyState === WebSocket.OPEN) upstream.close(); } catch (_) {}
    };
    server.addEventListener('close', closeBoth);
    server.addEventListener('error', closeBoth);
    upstream.addEventListener('close', closeBoth);
    upstream.addEventListener('error', closeBoth);
  } catch (err) {
    try { server.close(); } catch (_) {}
    return new Response('relay upstream error: ' + err.message, { status: 502 });
  }

  return new Response(null, { status: 101, webSocket: client });
}

/* ---------------- 自适应订阅 ---------------- */
async function handleSub(request, env, url) {
  const token = decodeURIComponent(url.pathname.split('/sub/')[1] || '');
  if (!token) return new Response('missing token', { status: 400 });

  if (!env.KV) {
    return new Response('KV 未绑定：请在 Worker「设置 → 变量 → KV 命名空间绑定」把命名空间绑定到变量名 KV', { status: 500 });
  }

  const userRaw = await env.KV.get('user:' + token);
  if (!userRaw) return new Response('invalid or expired token', { status: 404 });
  const user = JSON.parse(userRaw);
  const uuid = user.uuid;

  const host = url.host;
  const wsPath = env.WS_PATH || DEFAULT_WS_PATH;
  const name = encodeURIComponent('CF-' + (user.name || token.slice(0, 6)));
  const link =
    `vless://${uuid}@${host}:443` +
    `?encryption=none&security=tls&type=ws` +
    `&path=${encodeURIComponent(wsPath)}&host=${host}&sni=${host}` +
    `&fp=chrome&alpn=http%2F1.1#${name}`;

  const b64 = b64encode(link);
  return new Response(b64, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'profile-title': b64encode('CF-Worker-Relay'),
      'profile-update-interval': '24',
      'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0'
    }
  });
}

/* ---------------- 后台 API ---------------- */
async function handleAdmin(request, env, url) {
  // 仅后台页面
  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(ADMIN_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // 所有 API 需要 ADMIN_KEY
  const key = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
  if (key !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.KV) {
    return json({ error: 'KV 未绑定：请在 Worker「设置 → 变量 → KV 命名空间绑定」把命名空间绑定到变量名 KV' }, 500);
  }

  const api = url.pathname;

  // 列出用户
  if (api === '/api/admin/users' && request.method === 'GET') {
    const list = await env.KV.list({ prefix: 'user:' });
    const users = [];
    for (const k of list.keys) {
      const raw = await env.KV.get(k.name);
      if (raw) users.push(JSON.parse(raw));
    }
    users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ users });
  }

  // 新建用户
  if (api === '/api/admin/user' && request.method === 'POST') {
    let name = '';
    try { const b = await request.json(); name = (b && b.name) || ''; } catch (_) {}
    const uuid = uuidv4();
    const token = randHex(16);
    const user = { uuid, token, name: name || 'user', createdAt: Date.now() };
    await env.KV.put('user:' + token, JSON.stringify(user));
    await env.KV.put('uuid:' + uuid, token);
    return json({ user, subUrl: url.origin + '/sub/' + token });
  }

  // 删除用户
  if (api === '/api/admin/user' && request.method === 'DELETE') {
    const token = url.searchParams.get('token') || '';
    const raw = await env.KV.get('user:' + token);
    if (raw) {
      const u = JSON.parse(raw);
      await env.KV.delete('user:' + token);
      await env.KV.delete('uuid:' + u.uuid);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'not found' }, 404);
  }

  // 内部：供 VPS 同步 UUID 列表
  if (api === '/api/internal/users' && request.method === 'GET') {
    const list = await env.KV.list({ prefix: 'user:' });
    const uuids = [];
    for (const k of list.keys) {
      const raw = await env.KV.get(k.name);
      if (raw) uuids.push(JSON.parse(raw).uuid);
    }
    return json({ uuids });
  }

  return json({ error: 'not found' }, 404);
}

/* ---------------- 工具函数 ---------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function uuidv4() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 后台页面（内置） ---------------- */
const ADMIN_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CF-Worker Relay 后台</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:880px;margin:32px auto;padding:0 16px;color:#1f2937}
  h1{font-size:20px} input,button{font-size:14px;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px}
  input{flex:1;min-width:200px} button{background:#2563eb;color:#fff;border:none;cursor:pointer;margin-left:8px}
  button.del{background:#dc2626;margin:0}
  .row{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}
  th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;word-break:break-all}
  th{background:#f3f4f6} a{color:#2563eb}
  .hint{color:#6b7280;font-size:13px}
</style>
</head>
<body>
<h1>CF-Worker Relay 后台</h1>
<div class="row">
  <input id="key" placeholder="ADMIN_KEY 管理员密钥" type="password"/>
</div>
<div class="row">
  <input id="name" placeholder="用户备注名（可选）"/>
  <button onclick="createUser()">新建用户</button>
</div>
<p class="hint">订阅地址形如： <span id="origin"></span>/sub/&lt;token&gt;</p>
<table id="tbl">
  <thead><tr><th>备注</th><th>UUID</th><th>TOKEN</th><th>订阅链接</th><th>操作</th></tr></thead>
  <tbody></tbody>
</table>

<script>
const origin = location.origin;
document.getElementById('origin').textContent = origin;
function headers(){return {'X-Admin-Key': document.getElementById('key').value}}
async function load(){
  const r = await fetch(origin+'/api/admin/users',{headers:headers()});
  if(!r.ok){
    let detail='';
    try{ const t=await r.text(); if(t) detail='：'+t; }catch(_){}
    alert('加载失败（HTTP '+r.status+detail+'）\n提示：401=ADMIN_KEY 错误（请确认在 Worker 设置里添加了 ADMIN_KEY 环境变量）；500=KV 未绑定（请在 Worker「设置→变量→KV 命名空间绑定」绑定到变量名 KV）。');
    return;
  }
  const d = await r.json();
  const tb = document.querySelector('#tbl tbody'); tb.innerHTML='';
  (d.users||[]).forEach(u=>{
    const tr=document.createElement('tr');
    const sub = origin+'/sub/'+u.token;
    tr.innerHTML='<td>'+(u.name||'')+'</td><td>'+u.uuid+'</td><td>'+u.token+'</td>'+
      '<td><a href="'+sub+'" target="_blank">'+sub+'</a></td>'+
      '<td><button class="del" onclick="del(\''+u.token+'\')">删除</button></td>';
    tb.appendChild(tr);
  });
}
async function createUser(){
  const name=document.getElementById('name').value;
  const r=await fetch(origin+'/api/admin/user',{method:'POST',headers:headers(),
    body:JSON.stringify({name})});
  if(r.status!==200){alert('失败：'+(await r.text()));return;}
  document.getElementById('name').value='';
  load();
}
async function del(token){
  if(!confirm('确认删除该用户？'))return;
  const r=await fetch(origin+'/api/admin/user?token='+token,{method:'DELETE',headers:headers()});
  if(!r.ok){ let t=''; try{t=await r.text();}catch(_){}; alert('删除失败（HTTP '+r.status+t+'）'); return; }
  load();
}
document.getElementById('key').addEventListener('change',load);
</script>
</body></html>`;
