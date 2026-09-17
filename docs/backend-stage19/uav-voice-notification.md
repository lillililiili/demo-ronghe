# 飞手电话录音通知（2026-09-16）

用户要求在短信之外增加电话录音通知。本轮按系统自动外呼、接通后播放预先录好的通知音频实现。通知对象延续已有飞手提醒/劝离范围；不新增值班岗通知或人工通话录音管理。

后端实现、完整类/方法清单与隔离数据库验收见[电话录音通知实现与验收](../../../houtaiguanli/docs/电话录音通知实现与验收-2026-09-16.md)。两个仓库的代码均未作为本轮操作部署到共享服务。

## 页面与业务链

| 位置 | 输入与展示 | 操作与输出 |
| --- | --- | --- |
| 告警事件 → 处置进度 | 同一事件的短信与电话状态、录音名称、接通/播放时间、原因与记录 | 后台允许时重拨，仅登记该事件电话任务；现场观察与反制授权仍分别办理 |
| 融合感知 → 当前目标通知 | 精确关联告警的同一 advisory 数据 | 同一重拨接口；进入同一事件详情，不能沿用上一目标记录 |
| 合法性判定与空域详情 | 通知入口说明 | 导向告警事件，不自行认定通知成功 |
| 后台管理端 | 当前无 advisory 消费页面 | 不在业务前台新增录音配置或运维管理页面 |

## 自动执行与异常边界

- 触发输入：同一告警的当前目标观测、明确且有效的违规研判，或现有策略允许的近期人工确认；未知、陈旧、错配的依据不能自动拨打。
- 自动判定：复用短信资格规则及其时效窗口，但短信与电话分别防重；短信成功不能阻断首次电话通知，电话成功也不能阻断首次短信通知。
- 自动动作：后台独立任务调度电话通知，不依赖页面打开或浏览器计时器。前台读取接口不能建任务或拨号。
- 人工介入：明确失败且后台复核仍允许时显示重拨；未知通话结果先核对回执，不开放盲目重拨。重拨要求动作权限、数据范围、事件版本和幂等键。
- 未配置：电话默认禁用；缺少录音文件、模板标识、名称、文稿或可用通道时阻断。模拟适配器只在非 production 的 local/test 且 mock/replay 来源使用，不回退真实来源。
- 历史保留：通知事实独立于后续观测时效；保留历史短信、电话、现场记录和原有冻结交接材料。电话结果未知/失败不写成功联系记录，不抹掉现场观察。
- 结果口径：短信送达、电话接通、录音播放完成分别以回执为准；均不代表飞手理解、目标飞离、反制获准或案件办结。

## 追加接口契约

`GET /api/v1/uav-events/{eventId}/advisory` 保留原有 `auto_sms`，追加 `voice_mode` 和 `auto_voice`。电话状态包含 `enabled`、`status`、`reason`、`triggered_at`、`updated_at`、`can_retry`、`attempt_count`、`policy_code`、`trigger_source`、`evaluated_at`、`data_updated_at`、`recording_id`、`recording_name`、`answered_at`、`playback_completed_at`；无事实的时间不推算。

| 电话状态 | 页面含义 | 重拨 |
| --- | --- | --- |
| DISABLED | 电话录音通知未启用 | 无 |
| WAITING / CALLING | 等待自动拨打 / 正在拨打 | 无 |
| SIMULATED_PLAYED | 模拟接通并播放完成 | 无；不是真实通话 |
| FAILED | 电话通知失败 | 仅后台 `can_retry=true` 时 |
| UNAVAILABLE / BLOCKED | 配置/通道不可用或触发条件受阻 | 仅后台 `can_retry=true` 时 |
| UNKNOWN 或未知枚举 | 通话结果未确认 | 无 |

`POST /api/v1/uav-events/{eventId}/advisory/auto-voice/retry`：`{expected_version, note}`，携带 `Idempotency-Key`。返回结果只表示任务登记及当前事实，不表示已经接通。后续通过同一 overview 读取。

模拟成功联系记录使用 `kind=VOICE_SIMULATED`、`delivery_status=SIMULATED_PLAYED`，在原联系与观察历史内展示。记录内容注明模拟；人工补充联系不生成电话接通/播放回执。新成功联系之后，现场情况需以其后的观察记录为准。

## 实施与验收边界

本轮新增代码不包含正式外呼供应商、真实电话号码接入或录音上传管理；没有拨打真实电话、启用共享环境电话策略或向业务库追加演示通知。真实呼叫需后续接入供应商契约、可信接收对象、有效录音与可信回执，不能用本轮模拟验证替代。

## 前台代码变更说明

| 文件/类 | 方法/函数 | 方法作用与本次修改 |
| --- | --- | --- |
| `src/components/disposal/AutoVoiceNotice.vue` | `retry()`、`view` | 展示电话独立状态、录音和回执时间；校验事件未切换及可重拨后提交，保留版本冲突与不明确失败 |
| `src/components/disposal/autoVoiceView.js` | `autoVoiceView()` | 解释电话状态及来源；未知、处理中、完成、未启用不开放重拨，不用短信结果填电话事实 |
| `src/components/disposal/advisoryView.js` | `isAdvisoryContact()`、`advisoryActionView()`、`advisoryProgress()` | 电话模拟成功纳入联系事实；失败/未知记录不推导成功，不覆盖已有现场观察 |
| `src/components/disposal/AdvisoryRecords.vue` | `rows` 与展示模板 | 历史与冻结交接材料均能显示电话模拟类型及结果，标题允许换行 |
| `src/components/disposal/UavAdvisoryPanel.vue` | `openAction()` 与展示模板 | 告警处置加入电话卡；明确人工补录不会产生电话回执 |
| `src/pages/situation/SituationAdvisoryCard.vue` | 展示模板，无新增方法 | 融合感知复用同一电话卡及同一事件刷新链 |
| `src/services/uavAdvisoryApi.js` | `retryVoice()` | 调用电话重拨接口，携带版本与幂等键 |
| `src/hooks/useUavAdvisory.js` | 注释，无行为修改 | 说明只读轮询不触发短信或电话 |
| `src/components/modals/ControlledFormModal.vue` | 模板，无方法修改 | 重拨提交中显示完整的“正在处理”，去掉共享按钮原有省略号 |
| `src/pages/AlarmsPage.vue`、`src/pages/LegalityPage.vue`、`src/pages/airspace/AirspacePage.vue` | 展示文案，无新增方法 | 通知说明覆盖短信与电话，并保留通道启用及授权边界 |

路径相对 `dongying-vue/`。两级 AGENTS 补充双渠道独立回执约束，README 与通知流程文档补充入口和未接入边界，其他既有未提交改动保留。

## 已执行前台检查

- 六条临时 Node 行为检查通过，其中成功电话后的观察、未知电话不覆盖现场、外呼中不重复人工联系三条先验证失败，再修改为通过。
- `node tools/scan.cjs` 全部通过。
- `node node_modules/vite/bin/vite.js build` 通过，仍有既有的大包体积提示。初始 `npm run build` 解析到工作区外的同名 Vite，并因该处 Rollup 可选依赖缺失失败；使用本项目实际入口完成构建，未删除锁文件或变更依赖。
- `node node_modules/@playwright/test/cli.js test e2e/admin-migration.spec.js`：1 通过。初始 `npx playwright` 没有解析到可执行文件，使用本项目入口完成同一用例。
- 真实组件隔离浏览器验收：9 组、181 项展开断言通过；1280×720、1366×768、1440×900 三视口 × 八状态。覆盖短信/电话同事件展示、长文完整显示、无权限、必填、版本/幂等键、重复点击一次请求、只排队不假成功、403/409/500、切事件/迟到响应、卸载停止轮询。API 全部拦截，不能作为完整真实路由或电话通道验收。
- 应用异常为 0；临时 Vite 热更新 WebSocket 被浏览器本地网络检查阻止的 36 条环境日志已单列。报告与截图在 `/private/tmp/dongying-voice-qa-20260916/`，临时服务已停止。

## 后端验证汇总

- 受影响 H2 回归：71 项通过，失败、错误、跳过均为 0；隔离源码副本执行 package 通过。
- 隔离 PostgreSQL/PostGIS：50 项通过，失败、错误、跳过均为 0。验证独立通知任务、防重、事务、权限、部分/未知回执、禁用后的超时处理及升级路径；本次迁移存在，旧短信记录内容、时间和关联保留，重复迁移为 0。临时验收库已删除。
- 两仓 `git diff --check` 通过；没有应用业务库迁移、重启共享后台或启用电话策略。完整后端命令、类/方法清单及未接入能力见本页开头链接。
