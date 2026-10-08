# 第一条：协议输入与模拟响应验收包

这些文件用于平台接入与模拟响应验收。模拟回执不是实物动作证明。现有融合、研判、授权、审批和超时规则不变；协议 C、光电视频和整条业务处置链另行验收。

## 准备与操作

1. 后端使用 `local,qa`，始终保持 `app.dev-seed.enabled=false`；确认真实存在且有权限引用的单位、区域和启用的 replay MQTT 连接。接入本机 Broker 通常为 `127.0.0.1:1883`。缺资料时通过既有管理/授权接口补齐，不能用 Seeder、SQL 或伪造授权兜底。
2. 在 `http://127.0.0.1:8766/` 登录。保存原草稿后，用“场景工具 → 导入场景”载入 JSON；浏览器扩展不允许读取本地文件时，将 JSON 全文粘贴进现有“完整资料与接口字段”，点击“保存草稿”。两者使用同一场景契约。
3. 首先使用 `08-controlled-inputs.json`。开始模拟依次读取权限/范围、准备航线版本和计划、绑定设备、通过平台接口回读 SN/时间/航线/高度基准/设备绑定，全部一致后才发送观测。文件中的时间是 Asia/Shanghai 当天时段；跨日或场景时间变化产生新的受控提交。
4. 测试其他协议 A 文件。切换前停止全部收发。`07-target-silence` 需使用现有异常/混合模式，正常模式会沿用既有规则消除停报设置。以运行副本 `scene.json` 为实际输入，原稿留在 `source-scene.json`。
5. 在运行记录中查看发送、PUBACK、接口回读和错误。用“回读平台数据”核对目标/观测/研判；Broker 确认只证明消息交付给 Broker。原草稿及历史批次不要覆盖。
6. 协议 B 载入 `b-*.json`，由平台原有授权入口发出实际指令后模拟器才响应。未满足资格时保留阻断原因，不创建假授权、假审批或主动成功回执。回读 `/api/v1/device-commands/{command_id}` 及原有处置证据页面核对状态/回执。

本包没有声明真实飞手、实名核验、许可或审批。计划输入保留既有业务检查；未提供的条件继续显示缺失。目标坐标/高度/型号/频点为测试样本。

## 场景与预期

| 文件 | 观察重点 |
| --- | --- |
| 01-six-types | 雷达、5G-A、TDOA、AOA、DCD、RID 独立字段；前两者不补 SN |
| 02-missing-sn | TDOA 型号仍存在，原始身份线索为空 |
| 03-same-model | 同型号两个不同 SN，不能因型号生成相同身份 |
| 04-multi-source | 雷达/TDOA 同一目标按既有融合规则处理 |
| 05-aoa-bearing | 只有方位，平台有效目标位置为空 |
| 06-empty-frame | 工参正常，目标帧 `objects: []`；不代表飞离 |
| 07-target-silence | 第 10 秒起停报 100 秒，设备工参继续；不代表风险解除 |
| 08-controlled-inputs | 航线、有效版本、计划 SN/时间/范围/AMSL 资料回读 |
| b-success / b-failure | 分别返回 code 0 / 1，失败原因保留 |
| b-no-receipt | 记录收到指令、不响应，等待原有超时 |
| b-late | 延迟 120000 ms；须确认本机原超时小于该值，超时终态不应被迟到回执改写 |
| b-duplicate | 同一回执重复发送；平台只结算一次 |

稳定设备编号由设备种类和场景设备 ID 生成。跨模板复用相同设备；换单位/区域不能静默复用旧绑定。每次运行的批次、目标关联、时间、资料映射及日志独立保存。资料提交结果未知时先回读，不能无条件重复 POST。

04 多源场景使用固定的 `item1-multi-radar` / `item1-multi-tdoa` 专用设备号，重复运行仍复用它们。它们与独立目标场景分开，避免先前批次已建立的目标来源链路影响多源关联；不重新分配旧链路，也不更改融合算法。该场景的 SN 由 TDOA 提供，雷达报文仍不含 SN。

## 可选测试字段

目标 `protocolA` 可含 `uavModel`、`channel`、`bandWidth`、`reportSn`；`reportSn=false` 只控制可选 SN 的 TDOA，DCD/RID 继续发送协议要求的 SN。AOA 不生成 SN。设备 `emitEmpty=true` 在无目标时显式发送空目标帧。原有场景不需要添加这些字段。

设备 `protocolB` 示例：

```json
{"enabled":true,"response":"failure","delayMs":0,"duplicateCount":0,"failureMessage":"模拟设备拒绝执行"}
```

`response` 为 `success|failure|no_receipt`。仅本批次显式配置的 replay 设备订阅精确控制主题；不使用 `#` 通配订阅。QoS 1，retain=false。协议 B 字符串 msgNo 原样回传；与文档数字序号的差异保留。17 条白名单：雷达 10000；oe 30000/30001/30002/30003；诱骗 50002/50003/50005/50100/50101；干扰 60002/60003/60100/60101；驱鸟炮 70001；AOA 90000；TDOA 100000。oe 编解码覆盖不代表协议 C 或视频验收完成，默认模板不把 C 光电设备改接 B。

同一指令重复投递复用首次结果。延迟不占用 MQTT 回调线程。暂停/断连期间不发布；暂停瞬间未发出的回执仍留在当前批次，停止/会话失效/重启丢弃旧批次待发响应，不自动续发。

## MQTTX 核对与异常注入

以下命令在 `tools/device-simulator` 执行，输出只是 topic/payload 样本，不是 MQTTX 连接配置，不含凭据，也不会发布消息。

```powershell
python export_mqttx_messages.py scenarios/item1/01-six-types.json --manifest .data/<本批次>/manifest.json --output mqttx-a.json
```

在 MQTTX 连接同一 Broker；正常样本和异常样本分别发送。重复样本与正常样本载荷完全相同；错误设备、非法序号、retained、QoS 0 独立验证。retained 测试只在独立测试主题/测试设备进行，避免下一次订阅收到残留异常；不要批量发布全部样本。

协议 B 必须先从本批次 `device_control` 收到实际指令，把原始载荷保存为 `received-command.json` 后再导出：

```powershell
python export_mqttx_messages.py --control-command received-command.json --command-topic bridge/<provider>/device_control/<type>/<externalId> --output mqttx-b.json
```

分别包含成功、失败、精确重复、错误 msgNo、错误设备、错误来源和 retained 样本。一次只验证一项；使用不同实际指令验证成功和失败，不用假成功覆盖已有失败/超时。正常演示只使用模拟器自动响应。

## 证据和回归

每批 `.data/<batch>/` 保留原场景、实际运行场景、manifest、events 与回读。报告共享前去掉身份资料、会话、凭据和非本轮业务记录。仓库不提交 `.data`、日志、运行文件或凭据。

```powershell
python -m unittest discover -s tests
$cases = Get-ChildItem tests -Filter '*.cjs' | ForEach-Object FullName
node --test $cases
```

后端跨语言测试为 `ProtocolABPythonPostgresTest#pythonSixSensorsAndFiveReplyModesTravelThroughRealMqtt`，仅允许 loopback 的 `stage456_verify_*` PostgreSQL 库及独立 schema；配置 `POSTGRES_TEST_URL/USER/PASSWORD`、`ITEM1_SIMULATOR_ROOT`、`ITEM1_PYTHON`，并使已有 paho-mqtt 可导入后，在 server 目录运行 Maven。它使用真实 MQTT Broker、Python 生成器/响应线程与后端应用服务，覆盖六类落库事实及诱骗/干扰/驱鸟炮响应，不代表真实设备动作或完整业务授权验收。

已知边界：DCD/RID 的 SN 留在原始观测，是否选作融合身份继续遵守原白名单；AOA 位置和未知高度基准不提升为已知。历史目标、历史研判与冻结材料不回填。
