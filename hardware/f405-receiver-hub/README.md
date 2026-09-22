# STM32F405 接收阵列固件

这里保存原 `TrainSystem_F405_Master` 的 STM32CubeMX/CMake 固件工程，供训练系统接收阵列复现和继续开发。它是**固件源码**；用户提供的目录没有原理图、PCB 或生产文件，本目录不代表完整硬件制造资料。

## 组成与数据链路

- STM32F405 读取最多 4 路本地 CRSF 接收机；主机角色可汇总最多 4 个节点，共 16 路接收机。
- 主机或独立 4 路角色通过 USB CDC 输出换行分隔的 `rx_batch` JSON，约每 33 ms 一批，供教练端 Web Serial 读取。
- 节点角色通过节点串口输出 `node_batch`，约每 20 ms 一批；主机汇总后再向 USB 输出。
- `rx_batch.t` 来自 `HAL_GetTick()`，是设备启动后的单调毫秒计数，**不是 Unix 时间戳**。浏览器依靠它还原串口积压帧的真实间隔；修改格式或时钟语义前须同步阅读仓库根目录的 `docs/LIVE_DATA_PIPELINE.md`。
- USB 设备标识为 VID:PID `0483:5740`，产品字符串 `TRAINING_HUB`；接收机编号、命令及通道格式以 `Core/Src/app_main.c` 和主项目 README 的“接收阵列协议”为准。

## 开发过程留下的设计约束

这部分根据用户提供的 bring-up 与调试记录整理，并与**当前源码**核对；记录中的早期方案（例如主动 ping、旧的默认角色）不是当前实现。

| 设计意图 / 曾遇到的坑 | 当前边界 |
| --- | --- |
| 不重做 CubeMX 工程，不依赖屏幕、按键、ID 焊盘或 RTOS | `main.c` 保持 CubeMX 初始化入口，业务分在 `app_main`、`crsf`、`uart_mgr`、`usb_line`、`rx_state` 等模块；角色由编译宏选择，不靠板上 ID 脚。 |
| 4 路本地 CRSF 与 4 个节点不能混成同一身份 | 独立/节点角色的 USART1、2、3、UART4 对应本地 RX1–4，420000 8N1；节点 UART5 到主机为 2000000 baud。主机的 USART1、2、3、UART4 对应 Node1–4，汇总编号依次为 1–4、5–8、9–12、13–16。 |
| 对频指令必须按角色正确路由 | USB 的 `BIND:n` 在独立角色发往本地 UART；主机把全局编号换算为节点号/本地号后转发；本地任务发送 3 次绑定帧，间隔 100ms。不能把主机的全局编号直接发给节点。 |
| “在线”指 **UART 位号上有接收机**，不是识别某一颗设备的唯一 ID | 独立/节点角色给本地 RX 脚加下拉，以接收机 TX 空闲高电平刷新物理存在；拔出后约 100ms 停止输出旧位号。主机绝不能在自己的 Node 串口上运行这套本地接收机物理门控，也不能凭空生成 RX1–4 默认包。此判据依赖当前板级接线/电平，不是通用的插拔检测电路。 |
| 未对频接收机仍可能物理插着，不能把无 RC 当成不存在 | 无近期 `0x16` RC 通道帧时输出原始默认通道 `[992,992,172,992,191,191,191,191]`；真实 RC 与默认包分开。LinkStats 可更新质量/默认状态，但不能拿发送 ping 成功当作对端响应。历史实测接收机没有回复 `0x29 DeviceInfo`，主动 ping/DeviceInfo 路径已删除，不要未经实测把它恢复为在线依据。 |
| 串口和 USB 不许为了“可靠”阻塞采集主循环 | 各 UART 独立 Receive-to-Idle DMA/缓冲；CRSF 解析要容忍半包、粘包、CRC 错误。USB CDC 忙时跳过当前实时帧，不自旋等待；每个 JSON 输出以换行结束。16 路 `rx_batch` 容量不得因缩小缓冲而再次被截断。 |
| 调试信息不能占满正常 USB 数据链路 | `APP_SERIAL_DEBUG` 默认 `0`；开启后只用于现场排障。历史上尝试过 Node→Master 转发大段 debug，曾因行缓冲而丢失，现不应依赖它作为正常数据协议。实物 Node 板没有 USB 接口，不应把 Node USB 调试当成必备现场手段。 |
| 电源采样为辅助诊断，不阻塞数据采集 | ADC1 的 PC0 为 47k/22k 分压电压输入，PC1 为 INA180A2（50 V/V）+ 10mΩ 电流采样；主数据 JSON 使用整数 `vin_mv`/`current_ma`，避免浮点格式化负担。 |

历史开发记录报告 ST-Link 下载、状态 LED 闪烁和 USB CDC `CONFIGURED` 曾在板上成功，但**本次上传只验证了源码编译**，没有重新刷板测量 UART/ADC/USB。`adc_monitor_get_values()` 浮点辅助接口当前未被主数据路径调用；其电流单位换算仍需单独核验，不能把它当作已校准测量接口。

当前 CubeMX 引脚分配：USART1 `PA9/PA10`、USART2 `PA2/PA3`、USART3 `PB10/PB11`、UART4 `PA0/PA1`、UART5 `PC12/PD2`（均为 TX/RX）；ADC1 电压/电流为 `PC0/PC1`，状态 LED 为 `PC13`，蜂鸣器为 `PC7`。这是固件配置与历史开发记录，不代替 PCB 连线核查。

## 构建

需要 CMake、Ninja 和位于 `PATH` 的 Arm GNU Toolchain（`arm-none-eabi-gcc`）。在本目录运行：

```sh
cmake --preset Release
cmake --build --preset Release
```

**注意角色默认值：**原工程 `Core/Inc/app_config.h` 中 `APP_ROLE` 默认是 `APP_ROLE_NODE`，`NODE_ID` 默认是 `3`；目录旧名含 `Master` 不代表直接构建的固件就是主机。主机可使用单独的构建目录与编译定义，例如：

```sh
cmake -S . -B build/Master -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS=-DAPP_ROLE=2
cmake --build build/Master
```

`APP_ROLE`：`1` = 独立 4 路，`2` = 主机，`3` = 节点。节点还需配置 `NODE_ID`；刷写前务必确认角色、节点编号、目标板与接线，不能仅凭目录名选择镜像。此处只归档源码，不附带已刷写验证的固件镜像。

## 收录范围与许可证

保留应用源码、CubeMX `.ioc`、CMake、启动文件、链接脚本，以及当前 STM32F405 构建所需的 ST HAL、USB Device 和 CMSIS 文件。未收录 `build/` 编译产物、本机 `.settings/`、`.vscode/`，以及当前目标不用的 CMSIS DSP/NN 和其他芯片型号头文件，避免把大量无关生成文件上传到 GitHub。

`Drivers/` 与 `Middlewares/` 中的第三方代码保留各自的 `LICENSE.txt` 和源码版权声明；仓库其他部分的许可声明不能覆盖这些 ST/CMSIS 组件。特别是 ST USB Device 库的许可有设备使用条件，复用前请阅读 `Middlewares/ST/STM32_USB_Device_Library/LICENSE.txt`。
