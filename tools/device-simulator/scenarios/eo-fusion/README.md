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

## 实际指向与捕获模拟（2026-10-26）

`opposite-pointing-180s.json` 是独立的东西相反方向验收场景：两台光电与雷达/TDOA、两个移动目标，光电覆盖明确配置为半径 4 公里的全向圆。它不会改变旧场景或默认 1500 米、北向 120° 的静态覆盖。用现有模拟器网页导入该文件，点击开始发送，在融合感知分别为两个目标选择光电观察；先启动的任务占用一台设备，另一目标可选择另一台。核对两个设备的实际任务、云台角度及捕获状态，不根据设备显示名称绑定目标。场景仅运行三分钟，历史保留。

模拟云台由 `eo_pointing.SimulatedGimbal` 实现：真北为0°，顺时针水平角，仰角向上为正，单位度；初始朝向为安装覆盖中心（全向为北），初始俯仰0°，转速水平30°/秒、俯仰15°/秒，图像视场12°×8°。这些是明确的模拟校准参数，不代表真实设备能力。转向引导采用平台目标 latest_state 的当前有效实测位置与AMSL高度，时间须在15秒内；实际捕获独立检查本批唯一来源关联的当前场景实测样本是否落入实际云台视场。预测位置不代替实测，显式非MEAS、未知、失效或缺位置均返回UNKNOWN。设备安装位置与静态覆盖来自本次登记配置。俯仰仅接受明确AMSL的场景高度与明确AMSL的模拟设备安装高度，未知高度基准返回UNKNOWN。

BeginTracking仅回执TURNING、workState=0；此后按经过时间及目标方向推进云台。仅进入真实图像视场且在静态覆盖内才回TRACKING、workState=1并允许AI观测/关联帧。目标超出静态覆盖为LOST；来源不符、停报窗口、位置/高度基准缺失或过期为UNKNOWN，均停止AI关联帧。新的有效依据可重新转向、捕获；不会把丢失期间的时长累加为新指向的机械运动。停止仅接受精确任务，回STOPPED。空闲心跳仍报告当前姿态。

协议C `cameraStatus` 显式发送 `angleReference=TRUE_NORTH`、`angleUnit=DEG`、`calibrated=true`、`simulated=true`、`panOrientAngle`、`tiltOrientAngle`、`hfov`、`vfov`、`observedAt` 与 `trackingState`。图像视场与静态可覆盖范围独立。

录制视频继续标为模拟回放、非现场实拍；当前不声称画面地理位置与云台一致。既有编码帧时间、媒体时钟及服务端观测关联保持，缺少有效关联不生成目标检测框。测试视频关闭不妨碍云台捕获；AI配置关闭也不妨碍云台读取必要目标依据。

本地启动入口仍为 `python server.py --port 8766`；加载代码后须统一更新进程再导入。2026-10-26 本机联调已更新模拟器和后端进程，保持 local,qa 与 dev-seed=false；浏览器操作、回执与限制见后端仓库 `docs/acceptance/eo-direction-dispatch-2026-10-26.md`。测试使用 `test_eo_pointing.py` 验证不同位置、动态ID、两设备相反转向、非瞬时捕获、失联/重捕获、静态扇区限制、来源隔离及精确任务停止；既有媒体测试独立注入捕获前置条件。


### 多告警自动调度的15分钟输入

`one-camera-priority-900s.json` 为单光电、两个相反方向目标的同级告警排队输入；`two-camera-assign-900s.json` 为两台独立光电承接两目标。两者均通过既有fullchain准备入口下发配套飞行航线、计划和两个明确AMSL的禁飞区，再经规范化实测＋TDOA持续上报生成平台告警；没有预置告警、最终核实、调度或执行结果。仅使用现有本地QA模拟来源，不创建真实设备或通知目的地。

东侧从0秒在禁飞区内持续上报并停留180秒后向东移出；西侧前45秒静默，此后在西侧禁飞区内持续往返。先观察平台为东侧告警自动创建光电需求，再观察第二告警在同级不抢占规则下排队，或两设备情况下分别分配。东侧移出后由平台根据新的有效实测决定解除和停止，收到精确停止回执后才能启动排队任务。风险等级和优先级以平台实际规则输出为准，场景没有硬编码更高优先级或代填停止成功；若因现有权限、规则、来源或依据不足未产生告警，应如实报告，不能把场景编译成功当作多告警调度验收完成。

通过现有模拟器“导入场景→开始发送”运行上述文件，保持15分钟窗口用于浏览器观察。场景已通过编译与输入几何测试；实际多告警、排序、设备动作和视频切换仍须在更新后的本地服务中完成真实浏览器验收。

旧规范化场景缺省AMSL仍沿原上报契约保留，编译时增加 `_eo_altitude_datum_defaulted` 来源标记；EO模型遇到该默认值视为高度基准未明确，不据此计算有效捕获。新增专项文件均逐目标明确AMSL，不把真实来源或未知高度重标。

运行时EO工作线程现在缓存由模拟器所有者线程生成的完整心跳资料：活动任务携带精确 `metadata.taskId`，TURNING不报工作状态1；空闲、停止移除旧任务关联。传感器发布线程只读取缓存，不因慢媒体请求阻塞；缓存超过5秒降级UNKNOWN/workState=0，移除角度/视场并设置calibrated=false，保留原observedAt和精确任务关联用于失效旧捕获，不能借新心跳续期旧指向。测试覆盖工作线程的活动任务关联、陈旧缓存降级及停止后旧任务不复活。

视频关联按每一帧的实际媒体时刻选择最近的、服务端已保存且来源/任务/目标一致的EO观测，并保持正负2000毫秒的既有服务端窗口；不能把查询到的最新观测套给整批历史编码帧。模拟器LINKED状态以帧PUT回读的实际关联结果为准，而非仅有候选；状态附带 video_frame_timestamp、video_observation_timestamp、video_association_offset_ms，便于核对时间差。没有合适观测或服务端拒绝关联时保留UNLINKED，不伪填目标身份。


该关联仅限当前精确设备、当前OPEN任务、任务目标及当前AI stream_id。候选由后台 observation-associations 接口按设备来源和任务取回，模拟器另核对target_id、类别及近5秒观测；每帧再次按实际媒体时刻选差值不超过2000毫秒的最近观测，目标选择、另一台设备、另一任务、旧stream或停止后的记录均不能借用。最终LINKED以同一帧PUT返回的服务端实际关联为准。没有合适观测时画面可继续作为录制模拟视频播放，但检测不带可操作目标身份。

加载说明：`EoWorker` 是HTTP服务同一Python进程内的线程，`server.py` 启动时导入 `EoSimulator`。停止场景后重新开始不会重新导入修改后的 `eo_video.py`；这类源代码变更须在已完成现有设备真实停止与回执闭环后，由负责人重启模拟器HTTP服务。不得为了加载此修复中断仍运行的反制设备。本次补丁本身未重启任何进程。

本次回归命令（在模拟器目录执行，使用已有运行依赖，不安装新包）：

```powershell
$env:PATH = 'C:\Users\Admin（无密码）\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin;' + $env:PATH
C:\Python314\python.exe -m unittest discover -s tests -p 'test_eo*.py'
```

90项通过；日志位于后台仓库 `artifacts/eo-direction-20261026/simulator-frame-association-tests.log`。新增用例复现“最新观测距编码帧2067毫秒被拒、较早观测距帧933毫秒可关联”，同时验证超出窗口不填引用、服务端拒绝时不得宣称LINKED。实际West故障的逐帧差值仍以更新后运行回读诊断为准，单元复现不替代浏览器再次验收。

元数据上传与云台／观测调度现已隔离：运行时 `EoWorker` 开启两个元数据工作线程，每台设备最多一个在途任务，全局最多两个在途任务，不积压执行队列；其余设备在后续owner轮次重试，丢弃过时批次。上传仍仅使用真实编码帧、当前任务的来源关联和原有±2秒／5秒窗口。

每次提交冻结task_id、stream_id、编码进程身份、录制帧偏移和模板会话；后台线程仅把诊断与帧游标放入128项有界结果队列。只有EO owner在tick开始消费结果并重新核对当前任务、流、进程后，才更新已成功发送的 last_frame_number／last_frame_pts；可见LINKED状态另要求当前TRACKING。停止、任务切换或同task换stream／encoder后，旧响应不能回填新会话。短暂失捕时，同一会话已获后台成功的游标仍须记账，不能因隐藏LINKED而丢账重发。失捕立即将当前视频元数据置为UNAVAILABLE，停止置为STOPPED。关闭先拒绝新提交并使旧结果失效，取消未开始任务，shutdown不等待网络返回、不阻塞owner。

回归新增两设备慢上传期间观测仍每2秒调度、每设备及全局在途上界、shutdown不阻塞、旧task／stream结果及双游标不污染、失捕后旧LINKED不回填；93项EO测试通过。最新日志：后台仓库 `artifacts/eo-direction-20261026/simulator-metadata-scheduling-tests.log`。

公开只读验收字段位于 `GET /api/status` → `eo.devices[]`：`device_id`、`task_id`、`tracking`、`ai_observation`、`camera_status.observedAt`、`camera_status.panOrientAngle`、`video_metadata`、`video_frame_timestamp`、`video_observation_timestamp`、`video_association_offset_ms`、`video_metadata_error`。其中LINKED仅表示最近提交帧已获后台实际关联，页面实际显示帧仍应按媒体时钟核对，单次状态不能替代连续双路交互验收。



### 当前生效的分段帧时钟与批量上传契约

此节替代先前按全局origin外推、时钟变化终止整条媒体会话的临时方案；生产代码已移除该失效／重启策略。只在实际可读取的完整HLS分片内证明视频帧，不用FFmpeg progress推断未观察帧的UTC。

`HlsCalibrationClock.segment/measure_segment` 读取当前分片的PROGRAM-DATE-TIME和完整内容，FFprobe验证实际帧PTS等间距15fps，FFmpeg以 `-fps_mode passthrough` 解码所有帧并逐一读取画面条码。只有实际数量与EXTINF一致、条码连续、帧PTS一致的受控片段才可按本段PDT加实际PTS差计算UTC；单次最多30实际帧。跨EXT-X-DISCONTINUITY清除时间依据，必须有新的显式PDT后才恢复。异常仅拒绝对应分片；下一有效片段可恢复，不杀跟踪任务或AI视频。分片名诊断不含URL查询或媒体会话参数。

`EoSimulator._report_video_frame` 只上传该证明窗口内尚未成功接收的帧，跳过与本会话已接受UTC／media_time游标重叠或倒退的部分，不重写历史。逐帧仍只引用当前精确设备、任务、目标和来源的已存观测，时间差不超过2000毫秒；服务端5秒时效、单调、权限、来源及任务守卫全部保持。客户端保留传输余量，不抽帧、不加大容差。

上传采用一次 `PUT /local-interface-simulator/device-video-streams/{device_id}/frames/batch`：顶层stream_id、task_id和最多30个原始frames，每帧带frame_timestamp、media_time_ms和原detections；响应按输入顺序逐项返回index、时间、accepted、error_code及实际detections。只有accepted=true且回执index／时间／会话对应才更新accepted游标；只有后台实际LINKED及精确目标／观测引用对应才显示LINKED。单帧拒绝不伪造成功，任务／来源整体失效仍拒绝整批。

元数据工作线程每设备最多一个、全局最多两个在途任务；owner独占诊断与游标落地。短暂LOST不丢已成功PUT的同会话游标，但可见状态不回LINKED；任务／stream／编码进程切换后旧结果丢弃。新状态增加 `video_segments[]`（segment_id、program_date_time_ms、首末条码、实际帧数、首末packet_pts_ms）与 `video_segment_rejections[]`，用于下一次真实浏览器连续回读。

最终回归103项通过，包含真实FFmpeg录制HLS全帧解码、PTS／条码验证、discontinuity无PDT拒绝、异常段后恢复、分段PDT独立不改历史、仅上传已证区间、30帧单请求、重叠帧跳过、部分拒绝不记假游标、两设备慢上传隔离和旧会话结果丢弃。日志：后台仓库 `artifacts/eo-direction-20261026/simulator-segment-batch-final-tests.log`。最终运行表现仍以新jar与模拟器统一加载后的浏览器回读为准。

实际历史证据边界：先前失败AI流在采样时已结束、HLS返回404，不能事后声称还原其精确漂移。`hls-segment-origin-observed.json` 仅保存当时仍运行的两路RAW实际PDT／首帧条码20个样本，两路约22秒origin变化均0毫秒，不代表失败AI流也已通过。后续运行直接保留每段已证区间供核对。

元数据后台任务现在直接完成 `measure_segment`，不再在已后台执行的 `_report_video_frame` 内套第二层Future后读取旧缓存，也不持全局锁串行两台设备的解码。真实调用链回归先在旧实现稳定失败（外层任务在解码尚未完成时提前结束），改后同一次后台任务等待该实际片段完成并批量上传；EO owner线程不等待解码。

104项最终EO测试通过，日志 `artifacts/eo-direction-20261026/simulator-direct-segment-final-tests.log`，另保存 `nested-media-future-red.log` 与 `nested-media-future-green.log`。当前仍只证明并上传每次可用窗口内的帧；负载、超过保留时效或采样赶不上时允许缺框，不能把最新LINKED解释为整段逐帧连续覆盖，不能靠外推、补框或放大前台匹配容差掩盖。真实浏览器需跨多个播放时点验证框可用。
