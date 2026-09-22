# 1Panel 部署定制 Betaflight

本项目使用一个多阶段 Docker 镜像同时构建：

- 训练系统前端与服务器；
- Betaflight App 2026.6.1（Modern）；
- Betaflight Configurator 10.10.0（Legacy）。

最终容器内目录：

```text
/app/dist
/app/betaflight-dist
/app/betaflight-legacy-dist
/app/data
```

只有 `/app/data` 需要持久化。不要把旧的 `/app/betaflight-dist` 单独挂载为宿主机卷，否则
这个旧卷会覆盖镜像内的新构建产物。

## 在 1Panel 中更新

以下命令必须在 1Panel 的“主机终端”执行。看到提示符类似
`root@d7a5dccaa3ce:/app#` 表示仍在应用容器内，应先输入 `exit`，或者重新打开主机终端。

假设项目位于：

```text
/opt/fpv-training-system
```

如果当前旧容器的数据没有挂载到宿主机，必须在删除旧容器前复制出来。先查旧容器名：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

把下面的 `旧容器名` 换成实际名称：

```bash
OLD_CONTAINER='旧容器名'
mkdir -p /opt/fpv-backups/old-container-data
docker cp "${OLD_CONTAINER}:/app/data/." /opt/fpv-backups/old-container-data/
```

如果原来已经把数据挂载到 `/opt/fpv-training-system/data`，再做一份普通备份：

```bash
cd /opt/fpv-training-system
mkdir -p /opt/fpv-backups
cp -a ./data "/opt/fpv-backups/data-$(date +%Y%m%d-%H%M%S)"
```

新项目第一次部署且 `./data` 为空时，把旧容器数据迁入：

```bash
cd /opt/fpv-training-system
mkdir -p ./data
cp -a /opt/fpv-backups/old-container-data/. ./data/
test -f .env || touch .env
```

确认定制源码已经上传或拉取到该目录，并且存在：

```bash
test -f Dockerfile
test -f vendor/betaflight-configurator/src/fleet/FleetBridge.ts
test -f vendor/betaflight-configurator-10.10.0/src/fleet/FleetBridge.js
```

构建新镜像。第一次会下载两套依赖，通常需要数分钟：

```bash
docker compose -f compose.1panel.yml build --no-cache
```

镜像构建成功后，停止并删除占用旧端口的容器。已经由同一份 Compose 管理时可跳过：

```bash
docker stop "${OLD_CONTAINER}"
docker rm "${OLD_CONTAINER}"
```

同时在 1Panel 中停用旧编排，避免它自动拉起。然后启动新容器：

```bash
docker compose -f compose.1panel.yml up -d --force-recreate
```

检查容器里的三个入口：

```bash
docker exec fpv-training-system sh -lc '
set -eu
test -f /app/dist/index.html
test -f /app/betaflight-dist/index.html
test -f /app/betaflight-legacy-dist/index.html
ls -lh /app/dist/index.html /app/betaflight-dist/index.html /app/betaflight-legacy-dist/index.html
'
```

检查服务：

```bash
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1:3000/betaflight/
curl -I http://127.0.0.1:3000/betaflight-legacy/
docker logs --tail 100 fpv-training-system
```

浏览器中访问正式 HTTPS 域名并强制刷新。Web Serial 必须使用 HTTPS 或 localhost。

## 删除旧 BF

用上述 Compose 重建时，旧 `/app` 属于旧容器，删除旧容器后已经不会继续使用。确认新站点
正常后，可以清理未被使用的旧镜像：

```bash
docker image prune -f
```

如果以前把旧 BF 目录作为单独宿主机卷挂载，先在 1Panel 编排中删除那条挂载，再重建容器。
确认它不是 `/app/data` 后，才删除旧目录。例如旧目录明确为
`/opt/fpv-old/betaflight-dist` 时：

```bash
test -f /opt/fpv-old/betaflight-dist/index.html
rm -rf -- /opt/fpv-old/betaflight-dist
```

不要删除 `/app/data`、项目的 `./data` 或数据库备份。
