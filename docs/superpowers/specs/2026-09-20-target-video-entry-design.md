# 告警、反制办理与合法性研判视频入口

2026-09-20 用户要求三个页面均需实时视频。复用既有页面布局与目标关联，在告警详情、授权记录详情、合法性右侧详情原地展开视频面板。没有新增反制页面、改变权限或启动跟踪动作。

## 当前完成范围与缺口

- 当前接口只有 `GET /targets/{id}/eo-tracking-tasks`、`GET /device-commands/{id}` 等任务与回执读取，不提供可播放实时流地址。三处新增的是共享入口、关联状态读取与明确的异常状态；没有宣称真实实时视频已完成。
- 现场视频源、鉴权、流格式及浏览器播放契约待用户提供。不能假造 stream_url 字段、将录像文件冒充直播或因设备跟踪成功就自动显示现场画面。
- 当前复用已有模拟光电播放器，迁入共享组件目录；原飞行风险页面同步修改引用，保留原行为。新增 UAV 演示图形，避免新三页展示鸟群代替无人机。模拟画面不反映实际目标运动。

## 数据与状态

告警以当前 alarm.target_id 关联；反制记录按 TARGET 或 UAV_EVENT → 同事件告警 → target_id 关联；合法性以 selectedEvaluation.target_id 关联。没有关联或权限时明确提示，不找其他目标顶替。

读取跟踪任务必须返回当前 target_id；模拟画面须任务 OPEN，command_id 与 device_id 均对应当前任务、指令 SUCCEEDED 且 simulated 严格为 true。缺少模拟标记或真实成功回执不会降级到模拟。模拟预览由用户显式点击“播放模拟画面”。

折叠时不读取；展开后每五秒只读更新，12 秒超时转异常并停止轮询，用户可重试。切换目标、收起或离开时取消请求并释放播放器、流和动画；延迟返回不更新旧目标。视频画面不构成合法性判定、反制授权、飞离或风险解除事实。

## 代码清单

| 文件 | 方法/作用 |
| --- | --- |
| components/video/TargetLiveVideo.vue | refresh/clear/toggle：按目标读取、超时与取消、原地展开及显式模拟预览 |
| components/video/targetVideoState.js | targetVideoState：校验目标、任务、设备、回执及模拟身份 |
| components/video/SimulatedOpticalVideo.vue | 原模拟播放器迁入公共目录，frame 增加 UAV 绘制，沿用播放/暂停/全屏与卸载清理 |
| services/deviceApi.js | command/currentEoTrack 接受可选请求参数，供视频取消请求；旧消费者调用方式不变 |
| pages/AlarmsPage.vue | paintDetailContent 同步视频目标，删除永久禁用的旧视频按钮，增加共享面板 |
| pages/LegalityPage.vue | 模板绑定当前研判目标；选中记录变更重建视频面板 |
| pages/alarms/AuthorizationQueue.vue | readSubject 复用关联读取保存 targetId，详情展示视频，审批和急停保持原位 |
| pages/flights/components/RiskOpticalPanel.vue | 引用迁入公共目录的原模拟播放器 |

## 验证边界

13 条状态断言覆盖同目标模拟成功、任务缺失、目标/指令/设备不匹配、任务结束、等待/失败/超时、真实及缺失模拟标记，均通过。浏览器实测三页展开、无任务状态及研判切换目标后清理旧面板；控制台无错误，1280×720 检查新增区域文字完整。未实际验收现场流、断流重连或模拟成功播放器与三个页面的端到端链路。

前端 build 通过（保留既有大分包警告），scan 162 文件通过；既有旧管理地址迁移回归 1 项通过，使用 Node 直接调用已安装 Playwright（npx 包装入口不可用）。运行产物在系统临时目录，未新增测试框架、生产依赖或业务数据库数据。
