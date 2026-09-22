# 断网历史补传与条带恢复：专项交接

> **状态：本专项已完成并随当前稳定版本固化。** 本文保留为故障证据和设计决策记录，不再是待执行任务。后续修改必须先以 [`LIVE_DATA_PIPELINE.md`](./LIVE_DATA_PIPELINE.md) 的受保护契约为准，不得直接照搬本文末尾的历史任务指令重新设计数据链路。

## 1. 本次唯一目标

只解决下面一个问题：

> 教练端断网期间继续采集并显示；网络恢复后，浏览器把 IndexedDB 中的历史可靠帧补交给服务器，服务器按原采集时间写入 SQLite，重建条带与统计，并让教练端、观众端自动补齐断网缺口。

基线提交：`aabe4546ce5b8d8ec2fb1f1bb375b869a8f7ed1c`。

除断网补传外，用户已经在真实服务器环境验证通过：

- 正常联网实时显示；
- 教练端和观众端条带、统计、跳秒；
- 页面刷新后恢复完整服务器历史；
- 事件中途修改飞手配置；
- 删除/新增飞手和接收机迁移；
- 连续飞行与空闲条带无细缝。

这些均为冻结行为。修复不得重新设计或顺带整理在线主链路。

## 2. 最近一次真实环境证据

断网前/断网时页面显示：

```text
最近当前包落库 9/9 路
回补累计处理 135 包 / 落库 0 路
回补跳过：事件不存在 135 包
浏览器断网缓存：回补中，当前可见 至少 120 包
```

恢复网络几秒后：

```text
最近当前包落库 9/9 路
回补累计处理 141 包 / 落库 0 路
回补跳过：事件不存在 141 包
浏览器断网缓存：回补中，当前可见 至少 120 包
```

直接结论：

- WebSocket 已恢复，在线当前数据仍然能以 9/9 路写入；
- SQLite 性能、限频、旧包、未分配、训练时间窗均不是本次失败原因；
- 至少新增处理的 6 个回补包，其 `eventId` 在服务器 `training_events` 中查不到；
- 所以断网期间样本没有写入 SQLite，刷新后缺口必然仍为空白；
- `backfillMissingEventPackets` 是进程启动以来的累计值，135 包不一定全部属于最后一次测试，但 135 → 141 的增量可以确认本次重连仍在触发同一错误。

## 3. 当前数据路径

### 3.1 已验证在线路径，禁止改动语义

```text
串口约30Hz
  -> 教练端本地实时显示
  -> 同一份 live_batch 发送服务器
  -> 服务器广播观众端

约每200ms选中一帧
  -> 先写 IndexedDB
  -> 在同一份 live_batch 上增加 durable、packetId、eventId
  -> 服务器使用当前活动事件入 SQLite
  -> 服务器 ACK
  -> 浏览器收到 ACK 后删除 IndexedDB 记录
```

在线路径当前故意使用服务器活动事件作为权威事件。`processServerSerialPacket()` 对 `backfill === false` 的包调用 `activeEventQuery.get()`，不会使用客户端传入的 `eventId`。这保证了在线链路稳定，但也会掩盖客户端记录的 `eventId` 与服务器不一致：在线可以正常 9/9 入库，等同一记录以 backfill 回放时才暴露“事件不存在”。

### 3.2 当前断网回补路径

```text
断网或未收到ACK
  -> 可靠帧留在 IndexedDB
  -> 重连时冻结一个 recovery cutoff
  -> 旧记录以 backfill + persistOnly 补交
  -> 服务器按记录中的 eventId 查事件
  -> 按 capturedAt/clientTime 写历史
  -> ACK 后删除 IndexedDB
  -> 缓存连续两轮为空
  -> live_backfill_complete
  -> SQLite重建条带/统计
  -> live_timeline_resync
  -> 两端重新取得完整权威历史
```

`persistOnly` 在这里必须保留，因为过去的数据绝不能重新广播成当前摇杆画面。

## 4. 已确认的实现缺陷

### 4.1 回补严格依赖缓存中的事件ID，但在线路径不依赖它

位置：`server/features/training/createTrainingRuntime.js`，`processServerSerialPacket()`。

```js
const eventRow = backfill && eventId ? eventByIdQuery.get(eventId) : activeEventQuery.get();
```

因此：

- 在线包即使携带错误/过期 `eventId`，仍会写入服务器当前活动事件；
- 回补包使用同一个错误/过期 `eventId` 时，会被判定为 `missingTargetEvent`；
- 当前诊断缺少“回补包事件ID、服务器活动事件ID、样本时间”三者的对照，尚不能仅凭累计计数判断ID为何失配。

需要优先查明记录属于哪一种情况：

1. IndexedDB 中残留了已经删除的旧事件记录；
2. 服务器部署/数据库重建后事件ID变化，但浏览器仍保存旧ID记录；
3. 当前活动事件在客户端 `eventsRef` 与服务器 SQLite 中出现身份分叉；
4. 事件保存、开始训练与掉线发生竞态，客户端采集时事件尚未成功存在于服务器。

不得在没有打印实际ID和时间的情况下直接猜测。

### 4.2 “事件不存在”当前仍返回成功ACK，导致缓存被删除

位置：`server/features/training/createTrainingRuntime.js`。

事件查不到时当前返回：

```js
{
  accepted: true,
  event: null,
  missingTargetEvent: true
}
```

队列处理随后发送：

```js
accepted: Boolean(result.accepted || result.duplicate)
```

位置：`src/TrainingSystem.jsx`。

浏览器收到 `accepted: true` 后调用 `deleteCachedLivePacket(packetId)`。

这意味着：

> “事件不存在”的包虽然完全没有落库，却被当成已成功处理，从 IndexedDB 永久删除。

这违反“只有服务器完成去重、映射和 SQLite 处理后才能删除缓存”的设计意图，也是本专项必须修正的ACK语义。

### 4.3 没有真正重建也会更新“最近重建”并广播重同步

位置：`server.js`，`finalizeBackfillTimeline()`。

当前调用 `rebuildTrainingTimelineFromSamples(eventId, ..., { force: true })` 后没有检查返回值。事件不存在时重建函数会返回 `false`，但后续仍然：

- 更新 `lastBackfillFinalizedAt`；
- 更新 `lastBackfillEventId`；
- 广播 `live_timeline_resync`。

所以日志中的“最近重建”不等于条带真的重建成功。修复后只有找到事件且完成重建，才能标记成功并广播重同步。

### 4.4 客户端回补抽样会在没有服务器ACK时直接删除部分记录

位置：`src/TrainingSystem.jsx`，`scheduleOutboxFlush()`。

相邻记录小于 `OUTBOX_REPLAY_MIN_INTERVAL_MS` 时会加入 `skippedPacketIds`，随后直接调用 `deleteCachedLivePacket(skippedPacketIds)`。这与核心约束“可靠记录只在服务器ACK后删除”不一致。

它不一定是本次 `事件不存在` 的直接原因，但属于同一个断网恢复支路。修复时需要保证：

- 要么这些记录在写入 IndexedDB 前就不生成；
- 要么补交服务器并由服务器明确ACK；
- 不要在回补扫描过程中静默删除尚未确认的数据。

## 5. 推荐的最小修复方向

先增加足够诊断，再决定事件回补规则。不要直接把所有缺失事件包强行塞入当前活动事件。

### 5.1 第一步：把事件身份打印清楚

服务器诊断至少增加：

- 最近缺失的 `requestedEventId`；
- 当时服务器 `activeEventId`；
- 回补包 `packetId`；
- `clientTime/capturedAt`；
- 是否找到按时间覆盖该样本的候选事件；
- ACK结果与拒绝原因。

浏览器诊断至少能看到：

- 当前活动事件ID；
- IndexedDB最老一条与最近一条记录的事件ID；
- 本轮回补按事件ID分组后的数量。

诊断不得输出完整通道数组，避免日志膨胀。

### 5.2 第二步：服务器权威解析历史事件

建议规则：

1. 优先按记录中的 `eventId` 精确查找；
2. 精确事件不存在时，按 `capturedAt` 在 SQLite 中查找时间窗覆盖该样本的事件；
3. 只有恰好找到一个合法候选事件时才允许恢复，并记录 `resolvedBy: "capture_time"`；
4. 没有候选或候选不唯一时，不得污染当前事件；返回带原因的拒绝/隔离结果；
5. 绝不能仅因为服务器目前有活动事件，就把任意旧缓存归到它名下。

事件时间窗应以服务器数据为准：

- `started_at <= capturedAt`；
- 已结束事件要求 `capturedAt <= ended_at`；
- 活动事件可以使用服务器当前时间作为暂时上界；
- 若存在多个候选，视为歧义，不自动归属。

如果真实日志证明只是同一活动事件的ID分叉，也仍应满足采集时间落在该服务器事件时间窗内后才允许回补。

### 5.3 第三步：修正ACK状态机

ACK至少需要区分：

- `persisted`：已经成功落库，可以删除IndexedDB；
- `duplicate`：服务器已经处理过该 `packetId`，可以删除IndexedDB；
- `retryable`：临时失败，保留并稍后重试；
- `rejected/orphaned`：事件无法安全解析，不应无限快速重发，也不能伪装成成功。

对于 `missingTargetEvent`，不能继续返回普通 `accepted: true`。

若选择在浏览器将 orphaned 记录隔离，必须保留可观察数量和原因；不能静默丢弃。当前任务首先要保证本次活动事件断网记录能被权威解析并落库。

### 5.4 第四步：只在真实回补完成后重建

满足以下条件才执行最终重建和重同步：

- 对应事件存在；
- 该事件回补队列已经排空；
- 至少有成功落库或确认重复的回补结果，或者明确知道该代际无需重建；
- `rebuildTrainingTimelineFromSamples()` 返回成功；
- 重建后再广播完整 `live_state` 和 `live_timeline_resync`。

不要每补一包就重建。仍然保持“批量插入，最后一次性重建”。

## 6. 允许改动的范围

优先只修改以下位置：

- `server/features/training/createTrainingRuntime.js`
  - 回补事件解析；
  - 回补处理结果与ACK语义。
- `server.js`
  - 回补队列元数据；
  - 最终重建条件；
  - 回补诊断与重同步。
- `src/TrainingSystem.jsx`
  - IndexedDB回补扫描；
  - ACK状态处理；
  - 回补诊断显示。
- `src/liveOutbox.js`
  - 仅在确有必要时增加按事件统计、隔离或读取能力。
- `src/livePersistence.js`
  - 仅修改恢复代际判定等纯辅助逻辑。
- `scripts/verify-training-live.mjs` 或新增专项验证脚本。

不要修改：

- 30Hz实时广播结构和频率；
- 在线约5Hz可靠帧“同一消息升级”的架构；
- `persistProcessedSample()` 的飞行/空闲/反乌龟判定；
- 条带合并阈值、统计公式、跳秒逻辑；
- 接收机迁移历史映射规则；
- Monitor页面绘制逻辑；
- 教练端与观众端刷新重建的已验证主流程；
- 串口JSON解析器；
- 地面站、教学、赛道等无关模块。

## 7. 必须补上的自动验证

不能只验证“服务器收到了包”，必须验证SQLite和最终条带。

### 场景A：正常活动事件断网恢复

1. 创建并启动事件；
2. 正常在线写入一段飞行样本；
3. 模拟客户端断网期间产生多个带原始时间的 outbox 包；
4. 以 `backfill + persistOnly` 回放；
5. 断言 `training_samples` 出现断网时间段样本；
6. 断言 `training_segments` 补齐且无白缝；
7. 断言统计增加；
8. 断言每包只有成功落库/重复后才ACK可删除；
9. 断言最后只进行一次重建与重同步。

### 场景B：记录eventId不存在，但采集时间唯一属于当前服务器事件

验证安全的按时间解析能够把样本写入正确事件，并记录解析原因；不得依赖在线包碰巧使用活动事件。

### 场景C：真正属于已删除旧事件的孤儿缓存

采集时间不属于任何现存事件时：

- 不写入当前活动事件；
- 不返回伪成功ACK；
- 不无限高频重发；
- 诊断中明确显示孤儿数量和原因。

### 场景D：断网期间发生过接收机迁移

按每个样本的原始采集时间查询 `training_receiver_assignments`，确保迁移前后的接收机数据分别归到正确飞手。不要按重连时的当前配置统一映射。

### 场景E：回补不污染实时画面

回补期间：

- 当前30Hz画面立即恢复并保持优先；
- 历史包不能作为 `live_batch` 广播给观众；
- 当前摇杆、飞行状态和计时不能倒退到断网期间；
- 回补完成后直接用完整SQLite结果修正条带和统计。

## 8. 真实服务器验收步骤

1. 使用一个服务器中确实存在且处于活动状态的事件，记录其事件ID。
2. 清楚记录测试开始前浏览器 outbox 数量和其中的事件ID分组；不要盲目清空，以免掩盖孤儿处理问题。
3. 保持接收阵列连接并连续飞行至少30秒。
4. 断网30至60秒，确认教练端仍本地显示，观众端不伪造新数据。
5. 恢复网络：
   - 当前9路实时入库应立即恢复；
   - outbox数量应持续下降；
   - 回补落库路数必须大于0；
   - `事件不存在`不应继续增加；若有孤儿，应显示明确ID和处理状态；
   - 最终回补状态结束，不再长期显示“至少120包”。
6. 不刷新页面，确认教练端和观众端自动补齐断网区间。
7. 分别刷新教练端和观众端，确认SQLite完整历史仍在。
8. 核对总飞行、利用率、反乌龟时间与断网前后实际动作一致。
9. 再做一次飞手/接收机迁移回归，确认本专项没有破坏已通过逻辑。

## 9. 提交前验证命令

```powershell
npm run lint
npm run build
npm run verify:serial-json-stream
npm run verify:training-live
npm run verify:live-load
npm run verify:serial-port-claim
npm run verify:ground-station
git diff --check -- . ':(exclude)vendor/**'
```

新增的断网专项脚本也必须运行，并在交付说明中报告：补传包数、落库样本数、重建次数、最终条带缺口和outbox剩余数。

## 10. 新窗口可直接使用的任务指令

```text
只修复断网恢复后历史条带不能自动补齐的问题，其他功能不要动。

先完整阅读 docs/LIVE_DATA_PIPELINE.md 和 docs/OFFLINE_BACKFILL_HANDOFF.md。基线提交为 aabe4546ce5b8d8ec2fb1f1bb375b869a8f7ed1c。

真实服务器日志已经确认：当前在线数据恢复后仍能9/9路正常落库，但回补累计落库0路，事件不存在计数从135增加到141，浏览器IndexedDB长期显示至少120包。请先用代码和新增诊断确认回补记录eventId、服务器activeEventId、capturedAt的真实关系，再做最小修复。

必须修正两个已确认问题：
1. processServerSerialPacket在回补目标事件不存在时仍返回accepted:true，导致浏览器把未落库记录从IndexedDB删除；
2. finalizeBackfillTimeline不检查重建返回值，未重建成功也更新“最近重建”并广播resync。

推荐按“精确eventId优先；缺失时仅允许按capturedAt唯一匹配服务器事件；无匹配或歧义不得污染当前事件”的规则处理。ACK必须区分成功落库/重复、可重试失败和孤儿拒绝，不能伪成功，也不能无限快速重发。

保持在线30Hz单流、约5Hz同帧可靠落库、SQLite权威历史、接收机按采集时间迁移映射、当前实时优先、历史persistOnly不广播等现有设计不变。不要调整条带阈值、统计、跳秒、Monitor绘制、串口解析、地面站等无关代码。

增加可重复的断网专项自动测试，验证SQLite样本、segments、stats、一次性重建、双方resync和IndexedDB清空语义；然后运行文档中的完整回归命令。完成后说明修改文件、根因、ACK状态机、测试结果及真实服务器复测步骤。
```
