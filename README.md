# FPV Training Monitor System

一个基于 Web Serial + WebSocket + SQLite 的 FPV / 无人机训练监测系统。

目标是在“不安装本地程序”的前提下，仅通过浏览器、后端服务与 MCU 训练 Hub，实现多接收机实时训练监测、历史统计、观众同步观看，以及后续的大模型训练分析与语音播报。

---

# 项目特点

* 浏览器直接连接训练硬件（Web Serial）
* 最多支持 16 路 ELRS / CRSF 接收机
* 教练端实时低延迟监测
* 观众端无需硬件即可实时观看
* SQLite 持久化训练历史
* 自动恢复训练状态
* 实时飞行条带与统计
* 多飞手 / 多接收机管理
* 面向未来 AI 分析与语音教练扩展

---

# 当前功能

## 飞手管理

支持：

* 飞手库
* Rates / Profile
* 通道配置
* 模式范围配置
* Arm / Turtle / Mode 自定义

默认：

* CH5：Arm
* CH6：Mode
* CH7：Turtle
* CH8：预留

---

## 实时训练监测

实时显示：

* 摇杆位置
* 油门变化
* 接收机在线状态
* RSSI / LQ
* 飞行状态
* Turtle 状态
* 飞行条带时间轴

训练状态自动识别：

* Flying
* Idle
* Turtle

支持：

* 多飞手同时监测
* 实时波形
* 时间窗口缩放
* 历史条带恢复

---

## Web Serial 训练 Hub

浏览器直接连接 MCU：

* 无需安装驱动程序
* 无需本地客户端
* 自动识别训练 Hub
* 自动恢复连接
* USB 拔插自动恢复

---

## WebSocket 实时转发

支持：

* 教练端 Publisher
* 观众端 Subscriber
* 低延迟 relay
* live batch 广播
* 房间结构
* 自动状态同步

当前目标：

* 输入约 30Hz
* 观众同步约 30Hz

---

## SQLite 持久化

保存：

* 飞手
* 训练事件
* 训练 samples
* segments
* 统计数据
* 接收机状态

特点：

* 浏览器刷新不丢数据
* 清缓存不影响历史
* 服务端为权威数据源
* 支持 recompute 统计恢复

---

## 训练统计

自动计算：

* 总飞行时间
* 利用率
* 距离上次飞行
* Turtle 时间
* 飞行 segments

支持：

* 增量实时统计
* 从 samples 全量 recompute

---

# 技术栈

## 前端

* React
* Vite
* Web Serial API
* WebSocket
* SVG 实时波形
* SQLite 状态恢复 UI

主要页面：

```
src/pages/EventPage.jsx
src/pages/MonitorPage.jsx
src/pages/PilotLibraryPage.jsx
src/pages/HistoryPage.jsx
```

---

## 后端

* Node.js
* Express
* 原生 WebSocket frame
* SQLite
* REST API
* Live relay server

---

## 数据库

```
data/training.db
```

核心表：

* pilots
* training_events
* training_samples
* training_segments
* training_event_stats
* receivers

---

## 嵌入式

训练 Hub：

* USB CDC
* 多接收机聚合
* CRSF 输入
* JSON 串口输出
* BIND 指令支持

---

# 系统架构

```
MCU Training Hub
        ↓ USB CDC
Web Serial (Coach Browser)
        ↓
实时本地监测 UI
        ↓
WebSocket Publisher
        ↓
Node.js Relay Server
        ↓
SQLite Persistence
        ↓
WebSocket Subscribers
        ↓
观众端实时页面
```

---

# 当前状态

第一版训练系统已经完成：

* Web Serial
* 实时监测
* SQLite 持久化
* WebSocket relay
* 多接收机
* 飞行统计
* 历史恢复
* 自动串口恢复
* 实时观众同步

目前已经能够进行实际训练使用。

---

# 下一步方向

## AI / 大模型分析

计划加入：

* 飞行习惯分析
* 训练效率分析
* 炸机风险识别
* 飞手成长曲线
* 自动训练建议
* 自动训练总结

未来目标：

```
“像真人教练一样分析训练过程”
```

---

## 语音播报系统

计划加入：

* 实时语音提醒
* 飞行状态播报
* 训练节奏提醒
* AI 语音教练
* 自动鼓励 / 提醒

例如：

```
“你已经 8 分钟没有起飞”
“连续 Turtle 次数过多”
“本次飞行稳定性提升”
```

---

## 云端部署

未来计划：

* HTTPS / WSS
* 多训练场 room
* 鉴权
* 远程观众
* 手机端
* 平板端
* 云端训练分析

---

# 快速开始

## 安装依赖

```
npm install
```

---

## 启动前端

```
npm run dev
```

默认：

```
http://localhost:5173
```

---

## 启动后端

```
node server.js
```

默认：

```
http://localhost:3000
```

---

## 构建生产版本

```
npm run build
```

构建输出：

```
dist/
```

Express 会自动托管 dist。

---

# Web Serial 权限

首次连接需要用户点击授权：

```
navigator.serial.requestPort()
```

后续支持：

* 自动恢复
* USB 拔插恢复
* 页面刷新恢复

仅自动连接：

```
VID = 0x0483
PID = 0x5740
```

对应 TRAINING_HUB。

---

# 当前协议

## MCU 串口 JSON

```
{
  "type": "rx_batch",
  "v": 1,
  "t": 1710000000000,
  "items": [
    {
      "rx": 1,
      "ch": [172, 992, 172, 992, 1811, 172, 172, 172],
      "lq": 99,
      "rssi": -45,
      "t": 1710000000000
    }
  ]
}
```

---

## WebSocket live batch

```
{
  "type": "live_batch",
  "room": "default",
  "batch": {}
}
```

---

## bind 指令

浏览器写串口：

```
BIND:1
```

---

# 项目结构

```
server.js

src/
├── TrainingSystem.jsx
├── trainingShared.js
├── pages/
│   ├── EventPage.jsx
│   ├── MonitorPage.jsx
│   ├── PilotLibraryPage.jsx
│   └── HistoryPage.jsx

data/
├── training.db
├── bracket-state.json

dist/
```

---

# 当前重点优化方向

## P0

* Web Serial 长时间稳定性
* 实机压力测试
* 多观众延迟测试
* 完整 build 验证

---

## P1

* AI 飞行分析
* 自动训练总结
* 语音播报
* 实时提醒
* 飞手成长模型

---

## P2

* HTTPS / WSS
* 云端 relay
* 多 room
* 权限系统
* 手机端适配

---

# 项目目标

这个项目不仅仅是一个“接收机监视器”。

长期目标是：


*构建一个真正可量化、可分析、可 AI 辅助的 FPV 训练系统*


让 FPV 训练：

* 数据化
* 可视化
* 智能化
* 自动化

---

# License

MIT
