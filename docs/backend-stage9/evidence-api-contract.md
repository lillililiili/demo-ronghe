# 阶段 9 证据关联服务契约（协作者 A）

> 状态：本仓库实现稿。本切片只建设证据**文件底座**：摄取、元数据、真实内容哈希、业务关联、授权下载、冻结与访问留痕。
> 协作者 B 的阶段 10.4「C07 证据链」（轨迹/视频/图像/告警/判定/授权/处置/操作八类记录汇总、链完整性、目标 ID 变更回溯）不在本切片，B 只通过本服务引用文件，不自存文件。

## 交付边界

| 做 | 不做 |
| --- | --- |
| 真实字节入库，SHA-256 由服务端对内容计算 | 客户端提交的哈希、演示哈希、按哈希合并文件 |
| `evidence_link` 关联已存在的业务对象（见下表） | 处罚案件、空域、风险事件、反制授权记录等尚未建 FK 的对象 |
| 授权下载（无公开 URL）、访问成功/拒绝留痕 | 调阅按钮、页面手工「完整性筛选」 |
| 冻结/解冻阻断后续清理 | 按 Demo 年限自动销毁、ZIP 打包导出、异地备份 |
| 文件级校验：缺失 → `MISSING`，哈希不符 → `CORRUPT` | 证据链完整性校验值、合并前判定依据（B / C07） |

Q7（种类制度、保留期限、销毁/导出审批）未确认：`retain_until` 可空且空不表示立即过期；销毁接口返回 `422 POLICY_NOT_CONFIRMED`。

## 通用约定

沿用 `/api/v1`、`{ok,data}` / `{ok:false,error:{code,message}}`、snake_case、字符串 ID、epoch 毫秒、`page/size → items/page/size/total`（默认 1/20，最大 100）。未知/重复 query 400。写请求 `Idempotency-Key` 8–128 位。鉴权先于路径、query、multipart 解析。`ASSIGNED` 匹配同一有效 `(owner_org_id,district_id)` 元组；`ALL` 仍要求归属目录存在且启用。越权对象 404。

工程上限：单文件 32 MiB，不是业务保管容量指标。

## 权限

| 接口 | 权限 |
| --- | --- |
| 列表/详情/访问记录/CSV | `evidence:read` |
| 摄取 | `evidence:ingest` |
| 关联 | `evidence:link` |
| 下载内容 | `evidence:download` |
| 冻结/解冻 | `evidence:hold` |
| 文件校验（可更新 MISSING/CORRUPT/AVAILABLE） | `evidence:read` |

菜单 `evidence` 只控制导航。未关联文件仅 `evidence:ingest` 可见；已关联文件还须至少能按数据范围看到其中一个关联对象。返回的 `links` 逐项按同一范围过滤。

## 关联对象

`subject_kind` 与 `evidence_link` 六列一一对应，恰有一个非空：

| kind | 列 | 表 |
| --- | --- | --- |
| `EVENT` | `event_id` | `uav_event` |
| `DEVICE` | `device_id` | `ops_device`（范围经 `device_business_scope`） |
| `TARGET` | `target_id` | `target` |
| `PLAN` | `plan_id` | `flight_plan` |
| `COMMAND` | `command_id` | `device_command` |
| `COMMISSION` | `commission_id` | `commission_task` |

关联前对象必须存在且对操作者可见；设备/指令/调测在映射表为空时视为不可见。重复 `(evidence, kind, 对象)` 409 `LINK_EXISTS`。

## 种类与状态

`kind_code`（页面中文由前端映射，本接口不接受中文种类名）：

`EO_VIDEO` `EO_STILL` `TRACK_SNAPSHOT` `NOTICE_RECEIPT` `COMMISSION_REPORT` `COMMAND_LOG` `SCENE_PHOTO` `PENALTY_DOCUMENT`

`PENALTY_DOCUMENT` 只表示文件种类，不表示处罚案件已建设。

`status`：`PENDING` → 写入并算完哈希后 `AVAILABLE`；对象丢失 `MISSING`；内容与 `sha256` 不符 `CORRUPT`；`DESTROYED` 仅保留元数据（本期无写入入口）。

## 接口

```
GET    /api/v1/evidence-files
GET    /api/v1/evidence-files/export.csv
GET    /api/v1/evidence-files/{evidence_id}
GET    /api/v1/evidence-files/{evidence_id}/content
GET    /api/v1/evidence-files/{evidence_id}/access-logs
POST   /api/v1/evidence-files
POST   /api/v1/evidence-files/{evidence_id}/links
POST   /api/v1/evidence-files/{evidence_id}/verify
POST   /api/v1/evidence-files/{evidence_id}/holds
POST   /api/v1/evidence-files/{evidence_id}/holds/{hold_id}/release
```

### 列表

Query：`page,size,kind_code,status,subject_kind,subject_id,q`。`subject_kind` 与 `subject_id` 必须成对。排序固定 `captured_at DESC NULLS LAST, stored_at DESC, evidence_id DESC`。

列表项：`evidence_id,evidence_no,kind_code,original_name,content_type,size_bytes,status,captured_at,stored_at,held,link_count`。`sha256` 只在详情。

### 详情

固定字段：列表项 + `sha256,source_mode,owner_org_id,district_id,version,created_at,updated_at,links[],holds[]`。
`retain_until` 未设则省略。不返回 `object_key` / 存储路径 / 公开 URL。
`links[]`：`link_id,subject_kind,subject_id`（及可见时的 `subject_no`）。
`holds[]`：`hold_id,reason,held_by,created_at,released_at?,released_by?`。

### 摄取 `multipart/form-data`

字段：`file`（必填）、`kind_code`（必填）、`owner_org_id`、`district_id`、`captured_at?`、`subject_kind?`、`subject_id?`、`source_mode?`。
`subject_*` 成对；有关联时归属必须与对象归属一致，可省略 org/district 并由对象回填。无关联时 org/district 必填且须在操作者数据范围内。
`source_mode` 缺省为配置 `app.source-mode`，只允许 `mock|replay|live`。`captured_at` 不得晚于 `AppClock`。
成功 201：详情 DTO。幂等重放 409 `IDEMPOTENCY_REPLAY`。

### 下载

`evidence:download`；`AVAILABLE` 才 200。`PENDING` 409 `EVIDENCE_NOT_READY`；`MISSING`/`CORRUPT` 409 `EVIDENCE_UNAVAILABLE`；`DESTROYED` 409 `EVIDENCE_DESTROYED`。响应为文件流，`Content-Disposition: attachment`。每次尝试写入 `evidence_access_log`（成功 `GRANTED` / 拒绝在已定位到对象且缺下载权时 `DENIED`）。

### 校验

读取存储对象，重算 SHA-256：一致则保持或恢复 `AVAILABLE`；文件不存在 → `MISSING`；不符 → `CORRUPT`。返回 `{evidence_id,status,sha256,matches}`。`DESTROYED` 不改变状态。

### 冻结

Body：`{"reason":"..."}`（1–500 字）。已有未释放冻结 409 `HOLD_ACTIVE`。解冻 body 可空。冻结事实除释放列外不改写。

### CSV

与列表同筛选、同范围；UTF-8 BOM。不含文件内容。成功审计 `evidence_exported`。

## 给协作者 B 的应用服务

`com.uav.lowaltitude.modules.evidence.application.EvidenceAssociationService`

- `ingest(...)` / `link(evidenceId, subjectKind, subjectId)` / `listBySubject(subjectKind, subjectId)` / `get(evidenceId)`
- B 不直接写 `evidence_*` 表，不把文件字节写入自己的模块。

## 存储

`ObjectStoragePort` 本地目录 `app.evidence-dir`。数据库只存 `storage_backend=local`、`object_key`、`sha256`、大小。同哈希不是同一保管来源，不合并。
