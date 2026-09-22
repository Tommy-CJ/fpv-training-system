# 车队地面站代码结构

车队地面站保留在训练系统中。训练系统负责业务、权限、机库、预设、历史和数据库；定制
Betaflight 只负责浏览器串口、协议解码和原生调参界面。两部分通过同源 `postMessage`
协议通信，不共享页面内部状态。

## 目录

```text
src/
  groundStation/
    fleet/                         Agent 与 BF 的稳定协议
      contract.js                  消息、命令、事件、设备统一口径
      kernelCatalog.js             双内核地址和 API 范围
      FleetBetaflightClient.js     iframe 请求、响应和事件客户端
    betaflightFrameBridge.js       旧 DOM/CLI 兼容兜底，非主流程
  pages/
    GroundStationPage.jsx          业务页面和会话编排
    GroundStationPage.css

server/
  features/groundStation/
    registerGroundStationRoutes.js 机库、预设、快照、事件、历史接口
  database/
    initializeDatabase.js          车队表结构与迁移

vendor/
  betaflight-configurator/         Modern：Betaflight App 2026.6.1
    src/fleet/                     Modern MSP 适配和桥接
  betaflight-configurator-10.10.0/ Legacy：Configurator 10.10.0
    src/fleet/                     Legacy MSP 适配和桥接

scripts/
  verify-ground-station-fleet.mjs  协议、统一快照和事件表验证
```

## 串口和数据流

```text
Agent 连接按钮
  -> 当前 BF iframe 打开 Web Serial
  -> BF 读取 API 版本
  -> API 1.41-1.43 切 Legacy；API 1.44-1.48 使用 Modern
  -> BF 自己使用对应版本的 MSPHelper 解码
  -> src/fleet 生成统一 JSON 快照
  -> Agent 保存调参前/后快照并由服务器生成差异
```

普通调参不再进入 CLI。PID、Rate、滤波、电机、接收机、失控保护、VTX、电池、端口和模式
都通过 MSP 读取；原生页面发出的 `MSP_SET_*` 和 `MSP_EEPROM_WRITE` 会被旁路记录到
`fleet_tuning_events`。因此用户在 BF 页面点击保存，也能留下操作域和时间记录。

CLI 只保留给两个场景：

- 高级资源分配或自定义固件特有字段；
- 教练需要可恢复的完整 `diff all` 审计文件。

CLI 文本和 MSP JSON 是不同快照格式，服务器禁止跨格式、跨 target 或跨固件版本比较。
当前快捷“套用”只列出 CLI 预设：Modern 4.5.4 及以上通过后台 MSP CLI 写入，低版本由 Agent 临时接管串口并显示遮罩后写入。MSP JSON 版本用于快速匹配和差异审计，暂不把原始解码对象反向猜测成写命令。

## 统一快照原则

- BF 内核解码版本差异，Agent 不复制 MSP 字段表。
- 稳定字段放在 `device`、`profiles` 和 `settings`。
- 原始解码对象保留在统一域下面，避免丢失页面可见参数。
- `capturedAt` 和瞬时读取错误不参与参数差异。
- 整机“内转/外转”读取 `MIXER_CONFIG.reverseMotorDir`；单个 ESC 的 DShot 旋转方向没有
  可靠的 MSP 读取接口时明确显示不可读，不用别的字段猜测。

## 构建产物

服务器默认读取：

```text
/app/betaflight-dist/index.html
/app/betaflight-legacy-dist/index.html
```

也可以设置：

```text
BETAFLIGHT_MODERN_DIST_DIR=/绝对路径/modern-dist
BETAFLIGHT_LEGACY_DIST_DIR=/绝对路径/legacy-dist
```

Modern 源码要求 Node 24，Legacy 源码要求 Node 20。分别在对应 Node 环境中执行
`npm ci && npm run build`，再把各自 `dist/` 复制到上面的两个目录。不要在运行中的
应用容器内克隆或安装；构建应放在 1Panel 的构建阶段或独立构建容器中。

## 升级 Betaflight

1. 新建上游版本分支，不直接覆盖现有可用内核。
2. 先确认它支持的 MSP API 范围。
3. 移植该内核的 `src/fleet/`，以及 `msp.js`、`main.js`、`serial_backend.js` 三个接入点。
4. 只在内核内把新版 `FC` 数据映射到统一快照；不要改 Agent 的业务数据结构。
5. 运行 `node scripts/verify-ground-station-fleet.mjs` 和两个 BF 自身的 lint/build。
6. 真机验证连接、内核切换、四组 Profile 读取、原生保存事件和断开后的最终快照。
