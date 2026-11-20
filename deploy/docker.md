# Docker 部署指南

本指南用于在 Linux 服务器部署匠人之声照片领取服务。默认使用 Docker Compose，通过 `http://服务器IP:3000` 直接访问，无需 Nginx、域名或开放 80/443 端口。

当前直连方案使用 HTTP，上传凭证和照片传输不加密。如果后续需要加密访问，可以在其他端口（例如 8443）配置 HTTPS 代理。

## 当前交付形式

项目提供源码、`Dockerfile` 和 `compose.yaml`。Compose 使用 `build: .`，没有配置已发布镜像地址，也没有附带镜像归档文件。执行 `docker compose up -d --build` 时，会在部署机器构建镜像并启动容器。

镜像基于 `node:24-bookworm-slim`，包含应用代码和生产依赖。服务器无需另外安装 Node.js 或 GPU。首次构建需要能访问基础镜像仓库和 npm 包源。

## 1 准备服务器和源码

服务器需要安装 Docker Engine 和 Docker Compose 插件。确认 Docker 服务已启动，当前用户有权限执行：

```bash
docker version
docker compose version
```

将项目上传至 `/opt/jiangrenzhisheng-server`。至少包含：

```text
Dockerfile
compose.yaml
.dockerignore
.env.example
package.json
package-lock.json
src/
public/
deploy/
```

不需要上传本地 `node_modules`、`.npm-cache` 或开发机 `.env`。如果已有本地照片需要迁移，另行迁移数据库和照片；上传源码不会自动迁移这些数据。

后续命令均在服务器使用 Bash 执行：

```bash
cd /opt/jiangrenzhisheng-server
cp .env.example .env
chmod 600 .env
```

`cp` 只在首次部署执行，已有 `.env` 时保留原配置。固定使用此目录，避免更换目录名称后 Compose 创建新的项目和数据卷。

## 2 设置服务端配置

生成设备密钥，不需要在宿主机安装 Node.js：

```bash
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

编辑 `.env`，将生成的密钥填入 `DEVICE_KEYS`：

```dotenv
PUBLIC_BASE_URL=http://你的服务器公网IP:3000
DEVICE_KEYS={"experience-01":"填入刚生成的64位随机密钥"}
RETENTION_HOURS=72
MAX_UPLOAD_MB=30
MAX_STORAGE_MB=10240
TRUST_PROXY=false
```

将示例 IP 替换为服务器实际公网 IP。`PUBLIC_BASE_URL` 必须是手机可访问的地址，带上 `:3000`，不含业务路径；它决定返回的领取链接和二维码内容。不能填写 `localhost`、`127.0.0.1` 或容器名称。

每台设备使用独立密钥；`DEVICE_KEYS` 必须保持为一行合法 JSON，不能使用中文引号。不要提交或公开 `.env`。

Compose 会覆盖 `.env` 中以下三项，无需为 Docker 修改它们：

| 配置 | 容器中的实际值 | 含义 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 在容器内接收连接 |
| `PORT` | `3000` | 容器内服务端口 |
| `DATA_DIR` | `/app/data` | 命名卷挂载目录 |

直接部署保持 `TRUST_PROXY=false`。领取链接使用 `PUBLIC_BASE_URL`。

## 3 构建和启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 photos
curl --fail http://127.0.0.1:3000/healthz
```

健康接口应返回 HTTP 200；容器健康检查默认每 30 秒执行一次。日志中若出现密钥配置错误，修正 `.env` 后重新执行 `docker compose up -d`。

服务名是 `photos`，`compose.yaml` 已默认配置以下端口映射：

```yaml
    ports:
      - "3000:3000"
```

在云安全组和服务器防火墙放行 TCP 3000，从另一台设备访问 `http://你的服务器公网IP:3000/healthz`。无需为此服务开放 80/443，也无需安装 `deploy/nginx.conf`。局域网部署同理，使用手机可达的局域网 IP。

如果 3000 已被其他程序使用，可以将映射改为 `"9000:3000"`，并将服务端 `PUBLIC_BASE_URL`、客户端 `serverUrl` 的端口同步改成 9000，放行 TCP 9000。容器内部端口和健康检查仍使用 3000。

修改端口映射或 `.env` 后执行 `docker compose up -d`。已发出的旧二维码仍指向旧地址，切换前需安排旧链接在到期前继续可访问。

## 4 配置换装客户端和验收

在换装客户端的 `config/photo-server.json` 中设置（安装版位于 EXE 同级 `config` 目录）：

```json
{
  "enabled": true,
  "serverUrl": "http://你的服务器公网IP:3000",
  "deviceKey": "与服务端experience-01对应的随机密钥相同"
}
```

将示例 IP 替换为服务器实际公网 IP。客户端 `deviceKey` 只填密钥字符串，不填整个 `DEVICE_KEYS` 对象。

按实际流程上传成片，确认上传成功并展示二维码，再用手机微信和系统相机扫码，检查照片完整显示、长按可保存。首页 `/` 只显示领取说明，没有上传入口；实际领取页使用上传返回的 `claimUrl`。

## 5 更新和日常管理

更新前备份数据并保留上一版本源码。上传新代码时保留服务器 `.env`、`compose.yaml` 的现场修改及备份目录，然后执行：

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
```

修改 `.env` 后使用 `docker compose up -d` 使容器重新加载配置；单独执行 `docker compose restart` 不会重新注入修改后的环境变量。

常用命令：

```bash
docker compose logs --tail=100 photos
docker compose stop
docker compose start
docker compose down
```

`stop` 和 `down` 会中断上传与领取；普通 `down` 保留命名卷，之后使用 `docker compose up -d` 恢复。**不要执行 `docker compose down -v`，它会删除照片和数据库的数据卷。**

当前配置使用单机单进程 SQLite，不要用 `--scale` 启动多个服务副本。

## 6 数据和备份

照片和数据库位于 `photos-data` 命名卷的 `/app/data`，实际卷名通常包含 Compose 项目前缀。源码目录中的 `data/` 不会自动挂载进容器。重建镜像不会清空命名卷，但删除卷、切换 Compose 项目或更换服务器需要特别处理数据。

默认保留照片 72 小时，照片存储配额为 10 GiB；还需给数据库、镜像、日志和备份预留磁盘空间。备份不受应用过期清理控制，需要单独管理保留时间。

以下方式先停止服务，再将整个卷打包，保证 SQLite、WAL 和照片处于一致状态。会暂停业务，请在可接受的时间执行：

```bash
mkdir -p backups
chmod 700 backups
docker compose stop photos
docker compose run --rm --no-deps --user root --volume "$PWD/backups:/backup" photos sh -c 'umask 077; tar -czf "/backup/photos-data-$(date +%Y%m%d-%H%M%S).tar.gz" -C /app/data .'
docker compose start photos
curl --fail http://127.0.0.1:3000/healthz
```

确认打包命令成功，使用 `tar -tzf backups/实际备份文件名.tar.gz` 检查内容，并将备份复制到其他存储位置。备份命令失败也应及时启动服务。另行安全备份 `.env`、部署配置和使用的源码版本；密钥不能放在公开存储。

恢复时先停止服务并保留现有卷，将备份完整解压到用于恢复的空数据卷中，确保数据归容器内 `node` 用户所有，再将服务挂载到恢复卷并启动。不要把备份直接混入正在使用的数据目录。恢复不会延长领取有效期，启动清理仍会删除已到期记录。

## 7 常见问题

| 现象 | 检查项 |
| --- | --- |
| 镜像构建失败 | 基础镜像和 npm 包源是否可达，`package-lock.json` 是否上传 |
| 容器反复重启 | 查看 `docker compose logs --tail=100 photos`；检查 `.env` JSON 和密钥长度 |
| 3000 端口占用 | 检查是否已运行本项目的 systemd 服务或其他程序，避免重复部署 |
| 服务器本机正常，外部无法访问 | 检查映射是否为 `3000:3000`，云安全组及防火墙是否放行 TCP 3000，以及公网 IP 是否正确 |
| 上传返回 401 | 客户端密钥与服务端设备配置是否一致 |
| 上传返回 413 | 检查应用 `MAX_UPLOAD_MB` |
| 扫码指向 localhost 或旧地址 | 修改服务端 `PUBLIC_BASE_URL` 并重建容器配置，重新上传验收；旧二维码不会自动改变 |
| 更新后看不到旧照片 | 检查部署目录、Compose 项目名和卷是否变化，确认原卷仍存在 |
| 上传返回 507 | 检查应用照片配额；同时检查宿主机实际剩余磁盘空间 |

更多接口和过期策略见 [项目 README](../README.md)。
