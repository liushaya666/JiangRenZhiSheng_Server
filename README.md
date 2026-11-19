# 匠人之声 · 照片领取服务

接收体验设备上传的最终成片，生成独立领取链接和二维码，供用户手机查看、下载。照片存储在服务器磁盘，SQLite 保存记录。无需 GPU。

## 运行环境

- Node.js **24 或更新版本**（使用内置 `node:sqlite`）。
- 可用磁盘；手机可访问的域名或公网地址。
- 生产环境使用 HTTPS。推荐单进程部署，通过 Nginx 代理。

## 本地启动

```powershell
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成的密钥填入 `.env` 中的 `DEVICE_KEYS`，替换示例值。每台设备使用独立密钥，不要将 `.env` 提交版本库。

```dotenv
DEVICE_KEYS={"experience-01":"这里替换成上一步生成的随机密钥"}
PUBLIC_BASE_URL=http://127.0.0.1:3000
```

```powershell
npm.cmd start
```

检查 `http://127.0.0.1:3000/healthz`。没有上传页面，`/` 显示领取说明；实际领取页通过上传响应中的链接进入。

**手机测试**：将 `HOST` 改为 `0.0.0.0`，`PUBLIC_BASE_URL` 改为电脑的局域网 IP，例如 `http://192.168.1.20:3000`。手机连接同一 Wi-Fi，允许 Windows 防火墙访问 3000 端口。`127.0.0.1` 仅适用于电脑本机测试，不能用于手机扫码。

## 上传接口

`POST /api/photos`，使用 `multipart/form-data`，仅一个文件字段 `photo`。

请求头：

```http
Authorization: Bearer <设备密钥>
Idempotency-Key: <同一张成片固定的上传编号，例如会话 UUID>
```

`Idempotency-Key` 可选，推荐始终传入。相同设备、相同编号和相同文件重试时返回原记录（200），首次上传返回 201。相同编号用于不同文件返回 409。重试时请保留原文件字节与编号。

```powershell
curl.exe -X POST http://127.0.0.1:3000/api/photos -H "Authorization: Bearer YOUR_DEVICE_KEY" -H "Idempotency-Key: session_12345678" -F "photo=@C:/photos/final.png"
```

成功响应示例：

```json
{
  "token": "48位随机十六进制领取码",
  "claimUrl": "https://photos.example.com/p/<token>",
  "imageUrl": "https://photos.example.com/api/photos/<token>/image",
  "downloadUrl": "https://photos.example.com/api/photos/<token>/download",
  "qrCodeUrl": "https://photos.example.com/api/photos/<token>/qr.svg",
  "expiresAt": "2026-11-21T09:00:00.000Z",
  "width": 1080,
  "height": 1440,
  "bytes": 358400
}
```

客户端显示 `qrCodeUrl`，或自行把 **`claimUrl`** 转为二维码。不要把 `qrCodeUrl` 本身编码成二维码。上传成功以后才展示领取入口。

接口列表：

| 方法 | 地址 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 进程健康检查 |
| POST | `/api/photos` | 带设备认证上传 |
| GET | `/p/:token` | 手机领取页面 |
| GET | `/api/photos/:token` | 图片信息及链接 |
| GET | `/api/photos/:token/image` | 页面预览 / 长按保存 |
| GET | `/api/photos/:token/download` | 下载 JPG |
| GET | `/api/photos/:token/qr.svg` | 领取链接二维码 |

错误响应统一为 `{"error":{"message":"说明"}}`。常见状态码：400 报文错误、401 设备凭证错误、404 照片不存在或过期、409 上传编号冲突或处理中、410 重试记录已过期、413 文件过大、415 图片无法读取、429 上传频率过高、503 并发繁忙、507 存储配额不足。对 429/503 或处理中 409 按 `Retry-After` 重试；网络中断使用相同编号和文件重试。

### Electron 接入示例

建议在 **Electron 主进程**中调用，设备密钥不要暴露在网页代码中。配置服务端地址和凭证后再接入现有换装流程，本项目目前未修改换装客户端。

```js
import { readFile } from 'node:fs/promises';

async function publishPhoto(filename, sessionId, serverUrl, deviceKey) {
  const bytes = await readFile(filename);
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: 'image/png' }), 'final.png');
  const response = await fetch(new URL('/api/photos', serverUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deviceKey}`,
      'Idempotency-Key': sessionId,
    },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || '照片上传失败');
  return result; // 将 claimUrl / qrCodeUrl / expiresAt 传给界面
}
```

## 存储与过期策略

- 默认接受最大 30 MiB、3200 万像素的 PNG/JPG/静态 WebP；实际解码校验，不依赖文件名或 MIME 类型。
- 上传后转为质量 92 的 JPG，最长边最多 4096，不放大小图，移除 EXIF 等元数据。透明区域以白色填充，原 PNG 不保留在服务器。客户端原成片不受影响。
- 默认从上传完成起保留 **72 小时**。如需 24 小时，将 `RETENTION_HOURS=24`。
- 到期立即禁止访问，后台默认每 10 分钟删除过期文件及记录；启动时也执行清理。清理失败会记录错误并在下次重试。
- 默认存储配额 10 GiB、每设备每分钟 10 次上传、同时最多处理 2 个上传。配额统计由服务管理的照片，需另行监控服务器实际剩余磁盘。
- 随机领取码为 192 位随机数。**持有链接即可访问**，不是用户登录系统；请勿公开分享领取链接。
- 页面不引入外部脚本、统计或字体，设置禁止缓存和禁止 Referrer。不要通过 Nginx 静态公开 `data` 目录。
- 文件与 SQLite 同时保存在 `DATA_DIR`，如需备份应一起备份；备份保留策略须自行配置，在线清理不会删除备份。
- SQLite/WAL 适合本项目单机单进程，不要开启 Node cluster、多副本或将数据库放在网络文件系统上。

全部配置项见 `.env.example`。修改后重启服务生效。切换 `PUBLIC_BASE_URL` 后，已展示的旧二维码仍指向原域名，应维持旧域名可访问直到领取到期。

## Linux 部署（Nginx + systemd）

将项目放到 `/opt/jiangrenzhisheng-server`，安装 Node.js 24+，执行：

```bash
cd /opt/jiangrenzhisheng-server
npm ci --omit=dev
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

修改 `.env`：

```dotenv
HOST=127.0.0.1
PORT=3000
PUBLIC_BASE_URL=https://photos.example.com
DEVICE_KEYS={"experience-01":"替换为生成的随机密钥"}
DATA_DIR=/opt/jiangrenzhisheng-server/data
TRUST_PROXY=loopback
```

创建独立服务用户并配置目录权限：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin jiangren
sudo mkdir -p /opt/jiangrenzhisheng-server/data
sudo chown jiangren:jiangren /opt/jiangrenzhisheng-server/data
sudo chown root:jiangren /opt/jiangrenzhisheng-server/.env
sudo chmod 640 /opt/jiangrenzhisheng-server/.env
sudo cp deploy/jiangrenzhisheng.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jiangrenzhisheng
sudo systemctl status jiangrenzhisheng
```

`ExecStart` 默认 `/usr/bin/node`，若 `command -v node` 返回其他路径，修改 service。为真实域名配置 DNS 和 HTTPS 证书，将 `deploy/nginx.conf` 的域名、证书路径替换后放入 Nginx 配置目录，再执行 `sudo nginx -t` 与 `sudo systemctl reload nginx`。配置中的证书必须事先存在。

防火墙仅开放业务需要的 80/443 和运维端口；3000 仅监听回环地址。Nginx 的上传限制需比 `MAX_UPLOAD_MB` 略大。领取 URL 是访问凭证，示例已关闭访问日志；若接入其他代理、日志平台，也应隐藏照片路径和 Authorization。

## Docker 部署（可选）

准备 `.env` 并替换密钥和 `PUBLIC_BASE_URL` 后：

```bash
docker compose up -d --build
docker compose logs --tail=50
```

使用命名卷持久化 SQLite 和照片。容器端口只绑定宿主机 `127.0.0.1:3000`，Nginx 仍部署在宿主机。不要执行 `docker compose down -v`，否则会删除持久化卷。

## 验证

```powershell
npm.cmd run check
npm.cmd test
```

测试使用临时目录和随机本地端口，覆盖上传→领取→JPG 下载→二维码→到期禁止访问→物理清理、认证、错误文件、超限、幂等、频率及存储配额。

上线验收需使用真实手机：上传一张照片 → 展机显示二维码 → 微信及系统相机扫码 → 照片正常显示 → 长按保存。页面直接展示完整 JPG，仅提示用户长按照片保存，不设置打开原图按钮或其他保存方式。文件下载 API 仍保留供接口调用，但领取页不展示入口；网页不会自动写入手机相册。
