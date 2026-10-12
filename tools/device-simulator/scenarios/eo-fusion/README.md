# 光电三路融合专项（本地模拟，未运行真实设备）

`normal-180s.json` 为180秒雷达＋TDOA＋光电同一无人机场景；`ai-silence-180s.json` 在45—105秒仅停止AI观测，跟踪回执与设备心跳继续，110—120秒缺位置、120—130秒缺检测置信度、130—140秒类别冲突、140—150秒位置突跳。这些是确定性测试输入，不代表硬件精度。无真实视频、通知、反制验收结论。

在隔离local+qa库中关闭真实通知、反制及自动动作后，由项目负责人协调运行现有模拟器，导入上述JSON并开始。设置测试视频关闭仍可生成AI。每次登记产生独立批次与设备/来源；duration: 3 的单位为分钟，即180秒自动停止，历史保留。后端必须已部署任务约束的协议C融合实现。场景没有计划、空域或通知结果种子，不写入最终融合来源。

关联链：本次manifest批次→已登记传感器platform_id/fusion_device_id（登记返回的source_id是运维层来源，与目标source_links里的融合层来源是两套编号，不互相比较）→MQTT objectId（同一场景实体分配的mqtt_object_id）→GET目标source_links→服务端open_task.target_id→对应场景实体的engine.target_sample。仅接受replay且唯一匹配；名称、距离、平台融合经纬度和下发objectData不能成为观测。标准化来源目标本轮没有明确映射时不发AI。

`eoObservations.enabled: true` 显式启用AI；缺省保持状态回执。`detectConfidence`、`trackConfidence` 必须显式提供0—1有限数值；intervalSeconds 为0.1—300秒的有限数值，默认2秒，仅是测试输入周期；silenceWindows/anomalyWindows时间单位秒。正常只支持uav→drone、bird→bird；AMSL/AGL高度不填入协议C椭球高，只有场景明确ELLIPSOID才发送altitude。objectData/extention若下发则原样回传，不参与测量。

接收到已验证OPEN任务后，按 intervalSeconds（专项为2秒）独立读取当前任务和精确目标；状态回执仍每5秒发送，读完目标再次检查任务；切换、ENDING、停止、暂停或设备不可用即终止旧任务观测。AI缺失、映射歧义、目标读取失败时继续状态回执，视频开关独立。

验证命令（无需安装新生产依赖）：

```sh
python3 -m unittest discover -s tools/device-simulator/tests -p 'test_eo*.py'
python3 -m unittest discover -s tools/device-simulator/tests -p 'test_platform_client*.py'
```

验收时核对同一target_id的雷达/TDOA/EO来源、AI停报时仅EO贡献到期、异常不串至邻近目标且不新建幽灵目标。协议重复/迟到/旧任务拒绝由后端专项测试验证；本场景不伪造成功回执。真实设备位置、类别准确率、厂家椭球高、视频和通知通道继续待现场确认。
