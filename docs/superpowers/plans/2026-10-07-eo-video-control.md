# EO Video Control Implementation Plan

> 执行方式：本次会话按 executing-plans 逐项执行；用户已确认方案和实现，不再重复询问执行方式。

**Goal:** 运行中独立开启/停止模拟光电视频，并验证实际播放。

**Architecture:** Runtime 校验并提交配置，EO 所在线程应用配置。页面独立模块消费状态并调用同源 API，复用现有媒体登记与播放代理。

**Tech Stack:** Python 标准库、现有 FFmpeg/MQTT、原生 JavaScript、node:test。

## Global Constraints

- 本地 main 修改；保留其他变更，不增加依赖。
- 不改任务状态、设备协议、真实受控动作或平台鉴权；dev-seed=false。
- 密码不进入状态、日志、文件或导出。

## Task 1: 运行时开关

- [x] 在 tests/test_eo_video.py 写先失败测试：TRACKING 且视频关闭时开启→tick→一个编码器；关闭后 active task 不变、编码器退出、DELETE 注销；同一任务再次开启→第二个编码器。更换 task UUID 和 ENDING 状态验证禁止旧任务恢复。
- [x] 执行 `python -m unittest discover -s tests -p test_eo_video.py`，确认缺失 configure_video 而失败。
- [x] eo_video.py 新增 `configure_video(config)`；server.py 新增 `video_control(body)` 和 `sync_video()`；API 只更新 config，主循环执行 sync_video。
- [x] tests/test_video_control.py 覆盖 RUNNING 不改变 sent/elapsed/cancel、配置保密、非法布尔/未知字段、登录失效、关闭清理、HTTP 同源入口。

## Task 2: 页面控制

- [x] 新建 web/video-control.js，主按钮插入开始模拟旁；状态和设置入口独立显示，API 待完成时禁用重复操作。
- [x] runtime.js 在 applyRuntime 中调用 VideoUI.update；index.html 加载新模块。
- [x] Node 测试状态文案、切换中与离线不可判成功；真实浏览器测试按钮提交、状态回读和失败提示。

## Task 3: 联调与交付

- [x] Python 受影响测试与现有 Node 测试；业务前台 npm run build（只在 dongying-vue）。
- [x] 复用 pinned MediaMTX 1.21.1，回环 RTSP 18554/HLS 8888/API 9997，保留 8554 的原进程。
- [x] 准备一次服务重启，把本机媒体认证和 QA 配置注入后端及模拟器；不写明文凭据，不换库，不启用种子。
- [x] 真实浏览器开关视频并确认前台有画面且时间推进；停止保持 MQTT 和同任务；再开启恢复播放。
- [x] 更新 README、验收证据和代码变更说明；git diff --check。

验收证据：E:\houtaiguanlii\artifacts\local-runtime\eo-video-control-20261007\verification.md。真实浏览器完成开→关→开、非法设置拒绝、同任务和 MQTT 连续性及视频时间推进验证。
