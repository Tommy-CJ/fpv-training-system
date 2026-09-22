# 虚拟接收阵列

双击 `scripts/start-virtual-receiver.bat` 后，生成器通过项目现有的实时中继向训练系统发送与真实接收阵列相同的 JSON 数据，不再安装虚拟 COM 内核驱动，也不需要管理员权限。

生成器默认模拟 8 个接收机，以 30Hz 输出数据。通道值保持 CRSF 原始范围 172–1811，并周期性模拟待机、解锁、飞行、反乌龟、LQ、RSSI 和阵列电源数据。教练端、服务器持久化和观众端仍经过现有的统一解析与实时分发链路。

使用前先启动训练系统服务。生成器连接成功后，页面会显示“虚拟测试阵列”并开始产生条带；无需再点击串口选择器。关闭生成器窗口或按 `Ctrl+C` 后数据停止，不会留下 COM 设备或端口占用。

可在 PowerShell 中自定义：

```powershell
.\scripts\start-virtual-receiver.ps1 -Receivers 12 -RateHz 30
```

默认连接线上系统 `wss://app.1.gzfpv.cn/live-ws`。本地开发时可显式切换：

```powershell
.\scripts\start-virtual-receiver.ps1 -RelayUrl ws://127.0.0.1:3000/live-ws
```

只预览协议、不连接训练系统：

```powershell
node .\scripts\virtual-receiver-array.mjs --stdout --receivers 4 --rate 30 --count 5
```
