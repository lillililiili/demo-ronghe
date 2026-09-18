# 规则管理实现计划

> 执行方式：按已确认的 rule-management-practical.html 实现；前端组件委派独立实现，主任务负责接口、集成与验收。不新建分支或工作树，不提交其他任务改动。

**目标**：后台规则管理使用分类列表、单条规则弹窗、生效设置及真实版本记录；原处置预案与空域关联保留入口。

**范围**：管理端 `../houtaiguanli/ruoyi-ui` 和唯一后端 `../houtaiguanli/server`。当前先实现配置管理。运行引擎未消费此新配置时返回 `NOT_CONNECTED`，不得将启用配置说成自动执行生效；不下发设备、不发真实通知、不修改现有自动化行为。已异步询问用户是否同时扩展运行引擎。

**视觉基线**：`/Users/frank/.codex/visualizations/2026/09/17/01a0adf2-4fc2-7040-957a-292df142ce52/rule-management-practical.html`。复用现有管理端壳、Element Plus 组件、图标和 CSS token，保留完整文字。

## 约束

- `/api/v1`、Bearer 数据库会话、snake_case、`{ok,data,error}`、字符串 ID、epoch 毫秒。
- 新接口沿用 `responsePlans.read/auth`；三类为全局配置，需要 ALL 数据范围，范围不足返回明确 403。不扩大反制或设备动作权限。
- 三类 `verify/counter/dispose` 各一个规则组，已启用规则按 AND 组合；零启用即暂停。配置和执行状态分开。
- 规则字段白名单由后端目录返回；服务端校验类型、数值、持续时间、重复判定项和名称。
- 全组乐观锁 `expected_version`；写操作具幂等键；配置、版本快照、审计同一事务。
- 初始三组空配置，不插入原型示例阈值或自动启用规则。已有文字预案、发布版本和空域关联保持原样。
- 适用范围支持全部监测区域或从现有空域接口选择具体空域；不用虚构“重点区域”ID。时间使用 Asia/Shanghai，支持每日跨午夜，开始等于结束拒绝。
- 处置动作独立保存 notify/evidence/track/pilot；飞手提醒要求短信与电话录音分别回执。反制配置不授予授权。

## API 契约

GET `/automation-rule-groups/{category}` → Group:

```js
{
 category: 'verify', version: 0,
 settings: { scope_mode:'ALL', airspace_ids:[], airspace_names:[], schedule_mode:'ALL_DAY', start_time:'08:00', end_time:'20:00', timezone:'Asia/Shanghai', insufficient_wait_seconds:15, actions:[] },
 rules: [{rule_id, name, item_code, value, hold_seconds, enabled, updated_at, updated_by}],
 catalog: [{code, label, default_name, kind:'NUMBER|FIXED|SELECT', operator, unit, min_value, max_value, fixed_value, options:[], supports_hold, source}],
 execution_status:'NOT_CONNECTED', execution_message:'执行引擎尚未接入此规则配置；当前保存和启停不会触发自动动作。', can_manage:true
}
```

- POST `/automation-rule-groups/{category}/rules` body `{name,item_code,value,hold_seconds,enabled,expected_version}` → Group。
- PUT `/automation-rule-groups/{category}/rules/{id}` 同上 → Group。
- PATCH `/automation-rule-groups/{category}/rules/{id}/enabled` body `{enabled,expected_version}` → Group。
- PUT `/automation-rule-groups/{category}/settings` body `{scope_mode,airspace_ids,schedule_mode,start_time,end_time,timezone,insufficient_wait_seconds,actions,expected_version}` → Group。
- GET `/automation-rule-groups/{category}/history?page=1&size=20` → `{items:[{change_id,version,action,actor,created_at,details:[string]}],page,size,total}`。
- 空域选择复用 GET `/response-plans/airspace-options?page=1&size=20&keyword=`。

`value` 总为字符串（包括数字输入）；NUMBER 必填，无示例默认数值；FIXED 使用目录 fixed_value。GET 不写库。写入返回全组权威状态。409/网络未知结果后刷新，禁止假成功。

## 工作项

- [x] 后端新增配置 DTO、目录、事务服务、仓储、控制器和追加迁移；同时保留旧 API。记录真实操作者和前后差异。
- [x] 前端新增 `src/views/system/rules/` 页面及三个弹窗、`src/api/automationRules.js`、有意义的组件/模型测试；不复制演示业务状态。
- [x] 导航显示规则管理，旧地址保留；原处置预案作为页面次要入口，业务前台指引更新为对应入口。
- [x] API 测试覆盖持久化读取、重复判定项、越界、版本冲突、幂等、权限、空组暂停语义、跨午夜与非法时段、动作白名单、历史快照。
- [x] PostgreSQL 隔离验证新增迁移；管理端 lint/test/build；后端受影响测试/package；业务前台若改动执行 build/scan/admin-migration。
- [x] 浏览器核实列表/弹窗/只读/错误/保存/重新读取；记录功能验收与运行引擎未接入的实际边界。

## 当前进度

- 基线与现状已核对：旧 ResponsePlansView 仅文字预案管理；rule_set 是既有合法性规则集，不能冒充新配置执行接口。
- 两仓均有大量既有未提交内容，只在本任务文件内做增量修改。

- 配置管理、导航、原预案保留及真实数据库版本/审计均已实现；运行引擎保持 NOT_CONNECTED。
- 管理端全套 69 项通过，窄屏修复后规则相关 12 项通过，lint/build 通过；后端规则 H2 7、PostgreSQL 8、预案7、认证9，共31项及 package 通过。
- 业务前台仅变更预案入口文字；build/scan/admin-migration 1项通过。两个仓库 git diff --check 通过。
- 浏览器核对新建必填、95→96编辑回填、停用、跨午夜、实际空域名称、处置动作、历史和旧预案入口。390px 宽度弹窗裁切已修复并复验。后台权限边界由接口测试覆盖；未以浏览器实测只读账号。
- 没有提交、正式部署、真实通知/设备动作或执行引擎接入；详细文件清单与证据见 ../houtaiguanli/docs/规则管理实现与验收-2026-09-17.md。
