# 协作者 B 阶段 3：航线、空域、飞行计划与合法性只读闭环实施计划

> **执行要求：** 实施时使用 `subagent-driven-development` 工作模式；领导统一协调，两名执行者并行开发，一名审查者全程只读。所有修改只允许发生在 `main`，执行者不得提交，领导统一验证和提交。

**Goal:** 在不沿用前端 Mock 判定、不虚构生产规则的前提下，建立航线、空域、飞行计划、空间冲突事实和已保存合法性研判的后端只读闭环，并把现有飞行计划与合法性页面最小接到标准 API。

**Architecture:** Route 与 Airspace 是有不可变版本的逻辑根；FlightPlan 引用精确 RouteVersion；空间冲突接口只返回可复算的时间、水平和高度关系，不直接宣判非法；LegalityAssessment 读取已保存且引用精确输入版本的研判结果。所有 GET 先做动作权限，再用同一组织/区域范围谓词过滤列表、total、详情、版本和关联对象。前端整域切换到后端数据，接口失败不回退 `window.MOCK`。

**Tech Stack:** Java 17、Spring Boot 3.4.5、Spring JDBC/MyBatis 基线、Flyway、PostgreSQL 16/PostGIS 3.5、H2 测试、Vue 3、Vite 6、原生 JavaScript、Naive UI、现有 `MapView`。

**Global Constraints:** 不增加依赖；不修改已应用迁移；不碰设备、协议、目标和轨迹既有接口；不实现外部计划同步、规则引擎、人工改判、重算、风险/告警联动、导出或写操作；时间统一 epoch 毫秒；ID 为字符串；GeoJSON/WGS-84 坐标顺序固定为 `[longitude, latitude]`；AGL/AMSL 无可信换算时返回不可判定；生产环境不生成演示数据。

---

## 1. 领导结论与交付边界

当前仓库没有正式的 `route`、`route_version`、`airspace`、`airspace_version`、`flight_plan`、`assessment_result` 表，也没有相应标准 API。`FlightsPage.vue` 与 `LegalityPage.vue` 仍整体读取并计算 `window.MOCK`。因此阶段 3 不是简单接线，而是新的后端业务切片。

完整阶段 3 预计 **3–4 个工作日**。北京时间 **2026-09-06 09:00** 只作为阶段 3A 检查点，现实可交付边界为：

- 冻结只读契约、领域不变量和文件所有权。
- 建立版本化航线、空域、计划、研判结果的数据库基础。
- 增加原子读取权限及 local/test 确定性数据，验证生产零演示数据。
- 完成计划/航线/空域的最小标准 GET，以及 H2 和真实 PostgreSQL/PostGIS 核心验证。
- 若没有阻断问题，接通飞行计划页的列表、详情和航线查看；合法性页完整接线不作为明早硬承诺。

北京时间 09:00 的对外消息只允许是“待确认事项”清单；若没有，原文回复：`无待确认事项`。不夹带进度流水账、测试日志或功能宣传。

完整阶段 3 的完成定义是：计划查询、航线查看、空域冲突事实、已保存合法性结果均由后端提供，两个页面不再用 Mock 计算或伪造成功，并完成权限、PostGIS、构建与真实浏览器验收。

## 2. 本阶段做什么、不做什么

### 2.1 纳入范围

- 航线逻辑根与不可变航线版本。
- 空域逻辑根与不可变空域版本。
- 飞行计划读取，且计划引用精确航线版本。
- 航线版本与有效空域版本之间的时间、水平、高度冲突事实。
- 已保存合法性研判的列表与详情读取。
- `local` 固定演示数据与测试夹具；生产环境零演示数据。
- 飞行计划页和合法性页的最小 API 接线、加载/空态/错误态、不可用按钮禁用。

### 2.2 明确不纳入

- 权威外部计划、航线、空域的实时同步与 Inbox 消费。
- 生产规则引擎或自动生成 `LEGAL/ILLEGAL`。
- 人工复核、人工改判、重新评估、规则发布或历史追溯重算。
- 风险事件、无人机告警、处罚交接、通知、处置、导出和任何写接口。
- 飞手证件、身份证明、原始来源快照、凭据、内部网络信息、原始报文的 API 输出。
- 未确认的 AGL/AMSL 转换、地形 DEM 推算或坐标基准猜测。

未纳入能力在页面显示“尚未接入”，按钮禁用，不显示成功 Toast。

## 3. 领域模型与必须保持的不变量

```text
Route 1 ── N RouteVersion 1 ── N FlightPlan
Airspace 1 ── N AirspaceVersion
FlightPlan N ── N AirspaceVersion  （通过只读冲突事实）
FlightPlan 1 ── N LegalityAssessment
Target/Track 0..1 ── N LegalityAssessment
RuleVersion 0..1 ── N LegalityAssessment
```

- `RouteVersion` 和 `AirspaceVersion` 一经被引用即不可原位覆盖；变化创建新版本。
- `FlightPlan` 保存确切 `route_version_id`，不能在查询时取最大版本号。
- 航线中心线必须为非空、有效、SRID 4326、至少两个不同点的 `LineString`。
- 空域边界必须为非空、有效、SRID 4326 的 `MultiPolygon`。
- `corridor_width_m` 本计划暂定表示全宽，缓冲半径为 `corridor_width_m / 2`；如果业务不同意，冲突结论降级为 `UNDETERMINED`，不得静默换口径。
- 版本有效期采用半开区间 `[valid_from, valid_to)`；同一根对象有效期重叠时返回 `VERSION_AMBIGUOUS`，不得自动选最新版。
- 高度数值与 `altitude_datum` 同空或同非空；仅同为 AGL 或同为 AMSL 时直接比较。
- 负 AMSL 可合法存在；未知高度不得写成 0。
- 冲突事实分为 `horizontal_relation`、`height_relation`、`time_relation`；任一事实不足时给出 `UNDETERMINED` 和原因码。
- “未找到计划”必须区分权威源确认无计划、同步状态未知、范围不可见和证据不足。本阶段没有来源水位，因此不得仅凭查询空结果判非法。
- `LegalityAssessment` 是不可变结果记录；GET 不隐式重算、不写告警、不推进处置。
- 研判结论固定为 `LEGAL`、`ILLEGAL`、`UNDETERMINED`、`NOT_APPLICABLE`；单项规则固定为 `PASS`、`FAIL`、`UNDETERMINED`、`NOT_APPLICABLE`。
- local 数据中的合法/非法结果必须标记 `source_mode=mock` 与 `rule_version_code=LOCAL-DEMO-V1`；生产环境不生成这些结果。
- 所有根对象必须同时有 `owner_org_id` 和 `district_id` 才能被普通读取接口返回；`ASSIGNED` 按完整 `(owner_org_id, district_id)` 元组匹配。

## 4. 冻结的只读 API 契约

统一使用 `/api/v1`、`ApiResponse.ok(data)`、snake_case、字符串 ID；分页为 `page=1`、`size=20`、最大 100，响应为 `items/page/size/total`。所有列表固定排序并以唯一 ID 作为尾键。重复标量、未知参数、非法时间窗返回 400。

| 方法与路径 | 权限 | 作用与固定排序 |
| --- | --- | --- |
| `GET /api/v1/flight-plans` | `flight:read` | 计划分页；`start_at DESC NULLS LAST, plan_id ASC` |
| `GET /api/v1/flight-plans/{plan_id}` | `flight:read` | 计划详情和所引用航线版本摘要；越权 404 |
| `GET /api/v1/routes` | `route:read` | 航线根分页；`updated_at DESC, route_id ASC` |
| `GET /api/v1/routes/{route_id}` | `route:read` | 航线详情；越权 404 |
| `GET /api/v1/routes/{route_id}/versions` | `route:read` | 版本分页；`version_no DESC, route_version_id ASC` |
| `GET /api/v1/route-versions/{route_version_id}` | `route:read` | WGS-84 中心线与高度带；越权 404 |
| `GET /api/v1/airspaces` | `airspace:read` | 空域根分页；`updated_at DESC, airspace_id ASC` |
| `GET /api/v1/airspaces/{airspace_id}` | `airspace:read` | 空域详情与当前有效版本摘要；越权 404 |
| `GET /api/v1/airspaces/{airspace_id}/versions` | `airspace:read` | 版本分页；`version_no DESC, airspace_version_id ASC` |
| `GET /api/v1/airspace-versions/{airspace_version_id}` | `airspace:read` | WGS-84 边界、高度与有效期；越权 404 |
| `GET /api/v1/flight-plans/{plan_id}/airspace-conflicts` | `flight:read` + `airspace:read` | 返回时空冲突事实，不返回合法性结论 |
| `GET /api/v1/flight-plans/{plan_id}/legality-assessments` | `flight:read` + `assessment:read` | 已保存研判历史；`assessed_at DESC, assessment_id ASC` |
| `GET /api/v1/legality-assessments/{assessment_id}` | `assessment:read` | 精确输入版本、规则版本、结论和原因；越权 404 |

### 4.1 筛选参数

`GET /flight-plans`：

```text
page, size, status_code, source_code, route_id, uav_sn,
owner_org_id, district_id, window_from, window_to, keyword
```

`window_from/window_to` 必须成对，含义为计划完整时段与查询时段相交。任一计划时间缺失时，该计划不匹配时间窗筛选，但在无时间筛选时仍可返回并携带 `field_issues`。

`GET /routes`：

```text
page, size, enabled, source_mode, owner_org_id, district_id, keyword
```

`GET /airspaces`：

```text
page, size, kind_code, source_mode, owner_org_id, district_id, valid_at, keyword
```

### 4.2 DTO 关键字段

```java
public record PageDto<T>(List<T> items, int page, int size, long total) {}

public record GeoJsonLineStringDto(
        String type, List<List<BigDecimal>> coordinates, String coordinateSystem) {}

public record GeoJsonMultiPolygonDto(
        String type, List<List<List<List<BigDecimal>>>> coordinates,
        String coordinateSystem) {}

public record FieldIssueDto(String field, String reasonCode) {}
```

`FlightPlanSummaryDto`：

```text
plan_id, plan_no, status_code, source_mode, uav_sn,
start_at?, end_at?, owner_org_id, district_id,
source?, route?, field_issues, created_at, updated_at, version
```

`RouteVersionDto`：

```text
route_version_id, route_id, version_no, centerline?,
corridor_width_m?, min_altitude_m?, max_altitude_m?, altitude_datum?,
valid_from, valid_to?, change_reason?, field_issues, created_at
```

`AirspaceVersionDto`：

```text
airspace_version_id, airspace_id, version_no, kind_code, boundary?,
min_altitude_m?, max_altitude_m?, altitude_datum?,
valid_from, valid_to?, field_issues, created_at
```

`AirspaceConflictDto`：

```text
plan_id, route_version_id, airspace_id, airspace_version_id,
horizontal_relation, height_relation, time_relation,
conflict_code, unknown_reasons
```

`LegalityAssessmentDto`：

```text
assessment_id, plan_id, target_id?, track_id?, rule_version_id?,
assessed_at, conclusion_code, checks, unknown_reasons,
evidence_references, source_mode
```

不得返回 `source_snapshot`、`credential_ref`、原始 Inbox payload、内部规则参数、完整飞手证件或任一越权关联对象。

### 4.3 稳定错误码

```text
INVALID_PAGE
INVALID_TIME_RANGE
VALIDATION_ERROR
FORBIDDEN
FLIGHT_PLAN_NOT_FOUND
ROUTE_NOT_FOUND
ROUTE_VERSION_NOT_FOUND
AIRSPACE_NOT_FOUND
AIRSPACE_VERSION_NOT_FOUND
LEGALITY_ASSESSMENT_NOT_FOUND
VERSION_AMBIGUOUS
INTERNAL_ERROR
```

## 5. 四个对话的职责与文件所有权

### 领导

- 冻结本契约、迁移编号、公共权限码和错误码。
- 独占共享文件，避免并发覆盖。
- 每轮合并后运行测试；执行者不自行提交。
- 统一提交到 `main`，最终组织浏览器验收。

领导独占：

```text
server/src/main/java/com/uav/lowaltitude/modules/identity/domain/PermissionCode.java
server/src/main/resources/db/migration/V202609050009__stage3_read_permissions.sql
docs/backend-stage3/flight-airspace-assessment-api-contract.md
docs/flow-map.md
```

### 后端执行者 1：计划与航线

- 实现 `route/route_version/flight_plan` 迁移、服务端分页、详情和版本 API。
- 保证计划引用精确航线版本，历史结果不随新版本漂移。
- 完成 H2 API 测试、迁移测试和相应 PostgreSQL 测试。
- 后端稳定后独占 `flightApi.js` 与 `FlightsPage.vue` 做最小接线。

执行者 1 独占：

```text
server/src/main/resources/db/migration/V202609050010__route_and_flight_plan_read_foundation.sql
server/src/main/resources/db/postgresql/R__stage3_route_spatial_constraints_and_indexes.sql
server/src/main/java/com/uav/lowaltitude/modules/flight/**
server/src/test/java/com/uav/lowaltitude/modules/flight/**
server/src/test/java/com/uav/lowaltitude/migration/FlightRouteSchemaMigrationTest.java
dongying-vue/src/services/flightApi.js
dongying-vue/src/pages/FlightsPage.vue
```

### 后端执行者 2：空域、冲突事实与合法性读取

- 实现 `airspace/airspace_version/legality_assessment` 迁移与 API。
- 实现计划航线与空域的 PostGIS 冲突事实查询；不在 GET 中生成研判。
- 实现 local 固定夹具和生产隔离测试。
- 后端稳定后独占 `airspaceApi.js`、`legalityApi.js` 与 `LegalityPage.vue` 做最小接线。

执行者 2 独占：

```text
server/src/main/resources/db/migration/V202609050011__airspace_and_assessment_read_foundation.sql
server/src/main/resources/db/postgresql/R__stage3_airspace_spatial_constraints_and_indexes.sql
server/src/main/java/com/uav/lowaltitude/modules/airspace/**
server/src/main/java/com/uav/lowaltitude/modules/assessment/**
server/src/main/java/com/uav/lowaltitude/integration/mock/LocalStage3PlanningSeeder.java
server/src/test/java/com/uav/lowaltitude/modules/airspace/**
server/src/test/java/com/uav/lowaltitude/modules/assessment/**
server/src/test/java/com/uav/lowaltitude/integration/mock/LocalStage3PlanningSeederTest.java
server/src/test/java/com/uav/lowaltitude/integration/mock/ProductionStage3SeedIsolationTest.java
dongying-vue/src/services/airspaceApi.js
dongying-vue/src/services/legalityApi.js
dongying-vue/src/pages/LegalityPage.vue
```

### 审查者

- 全程只读，不改文件、不提交。
- 每个集成点检查动作权限、范围元组、越权 404、total 一致、分页排序、敏感字段、XSS、Mock 混用、空间算法、高度基准、测试是否真实执行。
- 只报 P0/P1；P2 记录到后续，不阻断明早检查点。

禁止所有角色修改：

```text
dongying-vue/public/assets/js/mock.js
dongying-vue/public/assets/js/pages/risk.js
server/src/main/java/com/uav/lowaltitude/modules/target/**
server/src/main/java/com/uav/lowaltitude/modules/device/**
现有已应用 Flyway 迁移
```

## 6. 实施任务（TDD 顺序）

### Task 1：领导冻结权限与契约

**Files:**

- Create: `server/src/main/resources/db/migration/V202609050009__stage3_read_permissions.sql`
- Modify: `server/src/main/java/com/uav/lowaltitude/modules/identity/domain/PermissionCode.java`
- Create: `docs/backend-stage3/flight-airspace-assessment-api-contract.md`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/identity/application/Stage3AccessControlServiceTest.java`

**Step 1: 写失败测试**

验证 `flight:read`、`route:read`、`airspace:read`、`assessment:read` 均为 ACTION 权限；无动作权限时在路径 ID、筛选参数校验前返回 403；生产角色默认无新增权限。

**Step 2: 运行失败测试**

```bash
cd server && ./mvnw -Dtest=Stage3AccessControlServiceTest test
```

Expected: FAIL，原因是权限枚举和目录尚不存在。

**Step 3: 最小实现**

新增四个权限枚举与权限目录记录。只在 local 开发种子中授予明确测试用户；生产不做默认授权。

**Step 4: 运行测试并检查差异**

```bash
cd server && ./mvnw -Dtest=Stage3AccessControlServiceTest,AuthApiTest test
git diff --check
```

Expected: PASS。

### Task 2：执行者 1 建立计划与航线读取

**Files:**

- Create: `server/src/main/resources/db/migration/V202609050010__route_and_flight_plan_read_foundation.sql`
- Create: `server/src/main/resources/db/postgresql/R__stage3_route_spatial_constraints_and_indexes.sql`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/flight/api/FlightDtos.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/flight/api/FlightReadController.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/flight/application/FlightReadService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/flight/infrastructure/FlightReadRepository.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/flight/api/FlightReadApiTest.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/flight/api/FlightReadPostgresApiTest.java`
- Test: `server/src/test/java/com/uav/lowaltitude/migration/FlightRouteSchemaMigrationTest.java`

**Step 1: 写失败测试**

覆盖迁移、正常列表/详情/版本、空页、分页、过滤、稳定排序、时间窗相交、重复标量、非法时间、401/403、ASSIGNED 交叉元组不可见、ALL 隐藏无归属数据、越权 404、精确版本引用、敏感字段不输出。

**Step 2: 运行失败测试**

```bash
cd server && ./mvnw -Dtest=FlightRouteSchemaMigrationTest,FlightReadApiTest test
```

Expected: FAIL，原因是表与 Controller 尚不存在。

**Step 3: 最小实现**

创建 `route`、`route_version`、`flight_plan`，实现六个计划/航线 GET。Repository 沿用 `TargetReadRepository` 的数据库类型分支：H2 契约测试不伪装 PostGIS；真实几何解析与有效性只在 PostgreSQL/PostGIS 测试中判定。

**Step 4: PostgreSQL/PostGIS 验证**

```bash
cd server && POSTGRES_TEST_URL="$POSTGRES_TEST_URL" POSTGRES_TEST_USER="$POSTGRES_TEST_USER" POSTGRES_TEST_PASSWORD="$POSTGRES_TEST_PASSWORD" ./mvnw -Dtest=FlightReadPostgresApiTest test
```

Expected: PASS，且报告中不是 skipped。

### Task 3：执行者 2 建立空域、冲突事实和研判读取

**Files:**

- Create: `server/src/main/resources/db/migration/V202609050011__airspace_and_assessment_read_foundation.sql`
- Create: `server/src/main/resources/db/postgresql/R__stage3_airspace_spatial_constraints_and_indexes.sql`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/airspace/api/AirspaceDtos.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/airspace/api/AirspaceReadController.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/airspace/application/AirspaceReadService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/airspace/application/AirspaceConflictService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/airspace/infrastructure/AirspaceReadRepository.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/assessment/api/LegalityDtos.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/assessment/api/LegalityReadController.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/assessment/application/LegalityReadService.java`
- Create: `server/src/main/java/com/uav/lowaltitude/modules/assessment/infrastructure/LegalityReadRepository.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/airspace/api/AirspaceReadApiTest.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/airspace/api/AirspaceReadPostgresApiTest.java`
- Test: `server/src/test/java/com/uav/lowaltitude/modules/assessment/api/LegalityReadApiTest.java`

**Step 1: 写失败测试**

覆盖空域分页/详情/版本、权限和范围、冲突接口双权限、合法性历史和详情、无 GET 副作用、关联对象范围、敏感输入快照不输出、未知原因完整返回。

PostGIS 用例必须覆盖：错误 SRID、空/自交/错误类型几何、真实相交、仅 bbox 重叠、边界接触、全宽转半径、同/异高度基准、有效期端点、重叠版本。

**Step 2: 运行失败测试**

```bash
cd server && ./mvnw -Dtest=AirspaceReadApiTest,LegalityReadApiTest test
```

Expected: FAIL。

**Step 3: 最小实现**

创建 `airspace`、`airspace_version`、`rule_version`、`assessment_result`。冲突 SQL 先用 4326 GiST 做候选过滤，再用 `geography` 进行米制走廊关系判断；边界语义未确认前返回 `UNDETERMINED/BOUNDARY_POLICY_UNKNOWN`，不得自行选 `ST_Covers` 或 `ST_Contains` 生成正式结论。

**Step 4: PostgreSQL/PostGIS 验证**

```bash
cd server && POSTGRES_TEST_URL="$POSTGRES_TEST_URL" POSTGRES_TEST_USER="$POSTGRES_TEST_USER" POSTGRES_TEST_PASSWORD="$POSTGRES_TEST_PASSWORD" ./mvnw -Dtest=AirspaceReadPostgresApiTest test
```

Expected: PASS，且空间用例实际执行。

### Task 4：执行者 2 建立 local/test 固定数据与生产隔离

**Files:**

- Create: `server/src/main/java/com/uav/lowaltitude/integration/mock/LocalStage3PlanningSeeder.java`
- Create: `server/src/test/java/com/uav/lowaltitude/integration/mock/LocalStage3PlanningSeederTest.java`
- Create: `server/src/test/java/com/uav/lowaltitude/integration/mock/ProductionStage3SeedIsolationTest.java`

**Step 1: 写失败测试**

固定夹具至少包含：

1. 有完整计划与航线、无冲突、已保存 `LEGAL` 的 local 演示记录。
2. 与禁止类空域有明确时空交集、已保存 `ILLEGAL` 的 local 演示记录。
3. 缺可信高度基准或计划时间，返回 `UNDETERMINED` 的记录。
4. 无可信中心线，仅在列表/详情展示、不绘图的记录。
5. 跨组织/区域记录，用于验证 ASSIGNED 隔离。

运行组合 `local`、`test`、`production`、`production,local`；最后两种必须保持零 Stage 3 演示数据。Seeder 必须同时受 profile 和显式 `app.dev-seed.enabled=true` 门禁。

**Step 2: 运行失败测试**

```bash
cd server && ./mvnw -Dtest=LocalStage3PlanningSeederTest,ProductionStage3SeedIsolationTest test
```

Expected: FAIL。

**Step 3: 最小实现并重复运行**

使用固定 ID 和统一 `AppClock`，按 source → route/airspace roots → versions → plans → assessments 的 FK 顺序幂等插入。不得复用前端随机 Mock，不得把演示数据放进 Flyway 迁移。

### Task 5：执行者 1 最小接通飞行计划页

**Files:**

- Create: `dongying-vue/src/services/flightApi.js`
- Create: `dongying-vue/src/services/airspaceApi.js`
- Modify: `dongying-vue/src/pages/FlightsPage.vue`

**Step 1: 增加 API 适配层**

复用 `apiClient.js`，实现服务端分页与全页拉取辅助函数；页面不得再读取 `M.flightPlans`、`M.routes`、`M.airspaces` 作为真实数据源。

**Step 2: 最小页面接线**

- 保持布局、样式、导航和现有点击方式。
- 列表、筛选、分页、详情、路线和空域覆盖物来自 API。
- 无可信几何显示“不可绘制”，不画默认线或 `(0,0)`。
- 计划/空域动态文本进入 legacy `innerHTML` 前统一转义，禁止存储型 XSS。
- 风险、通知、导出和其他写按钮禁用并显示“尚未接入”。
- 401/403/404/500/网络错误显示真实错误，不回退 Mock。

**Step 3: 构建与静态检查**

```bash
cd dongying-vue && npm run build
cd dongying-vue && node tools/scan.cjs
cd dongying-vue && node tools/falsify.cjs
```

Expected: 全部 PASS。

### Task 6：执行者 2 最小接通合法性页面

**Files:**

- Create: `dongying-vue/src/services/legalityApi.js`
- Modify: `dongying-vue/src/pages/LegalityPage.vue`

**Step 1: 删除竞争真值**

页面不得继续执行 C01/C02/C03 Mock 规则、默认 AGL、缺失置信度补值、同区域任意空域兜底或在前端生成合法性结论。

**Step 2: 展示已保存结果**

- 展示 `conclusion_code`、规则版本、精确输入版本、单项检查、未知原因和证据引用。
- local 演示结果明确显示“演示规则/模拟来源”。
- 无结果显示“尚无已保存研判”，不能把空结果写成合法。
- 人工改判、重算、转告警、风险通知等入口禁用并标“尚未接入”。
- API 失败不回退 Mock，不修改 `window.MOCK`。

**Step 3: 构建与静态检查**

重复执行 Task 5 的三条前端命令。

### Task 7：领导集成、审查与提交

**Step 1: 运行后端完整验证**

```bash
cd server && ./mvnw test
cd server && ./mvnw package
```

核对 `server/target/surefire-reports` 中实际 Tests run、Failures、Errors、Skipped；PostgreSQL/PostGIS 用例若被 skipped，不得写“PG 已通过”。

**Step 2: 运行真实 PostgreSQL/PostGIS 套件**

```bash
cd server && POSTGRES_TEST_URL="$POSTGRES_TEST_URL" POSTGRES_TEST_USER="$POSTGRES_TEST_USER" POSTGRES_TEST_PASSWORD="$POSTGRES_TEST_PASSWORD" ./mvnw -Dtest=FlightReadPostgresApiTest,AirspaceReadPostgresApiTest test
```

只允许使用自动创建并删除的隔离 schema；不得 repair、clean 或复用默认 `uav` 业务库来掩盖校验问题。

**Step 3: 前端验证**

```bash
cd dongying-vue && npm run build
cd dongying-vue && node tools/scan.cjs
cd dongying-vue && node tools/falsify.cjs
git diff --check
```

**Step 4: 真实浏览器验收**

```text
登录
→ 打开飞行计划
→ 看见后端 local 计划
→ 服务端翻页/筛选
→ 点击计划
→ 查看精确航线版本
→ 查看空域覆盖与冲突事实
→ 打开合法性研判
→ 分别查看 LEGAL、ILLEGAL、UNDETERMINED
→ 刷新后仍来自后端
→ 断开后端后显示接口错误且不回退 Mock
```

同时验证 1280×720、1366×768、1440×900；检查控制台错误、XSS 载荷、地图卸载后只保留一个活动宿主和 overlay。

**Step 5: 审查者最终只读复核**

阻断项包括：越权泄露、范围 total 不一致、空间单位错误、AGL/AMSL 混算、生产生成 Mock、接口失败回退 Mock、前端自行判合法、动态值未转义、PG 用例跳过却宣称通过。

**Step 6: 领导统一提交**

```bash
git status --short
git diff --check
git add <仅阶段3已核对文件>
git commit -m "feat: add stage 3 flight legality read slice"
```

不得使用 `git add .`，不得把现有 `.planning/`、`.worktrees/`、其他未跟踪计划、DOCX 或设备资料带入提交。

## 7. 北京时间排期

### 阶段 3A：只读基础检查点（2026-09-05 09:40 至 2026-09-06 09:00）

| 时间 | 领导 | 执行者 1 | 执行者 2 | 审查者 |
| --- | --- | --- | --- | --- |
| 09:40–11:00 | 冻结契约、迁移号、权限码、测试矩阵 | 等待契约后写 RED 测试 | 等待契约后写 RED 测试 | 审查范围和不变量 |
| 11:00–17:30 | 合并共享权限；处理冲突 | 航线/计划迁移、API、H2 | 空域/研判迁移、local/test 数据、H2 | 第一轮只读审查 |
| 17:30–21:30 | 集成两侧迁移/API | 修复计划/航线问题 | 修复空域/研判问题 | 权限、范围、Mock 隔离复核 |
| 21:30–01:30 | 组织真实 PG/PostGIS 验证 | 计划/航线 PG 用例 | 空域/空间 PG 用例 | 审核空间与高度语义 |
| 01:30–05:30 | 决定是否进入最小接线 | 飞行计划页最小接线 | 合法性 API 适配准备 | XSS 与失败态审查 |
| 05:30–06:30 | 后端完整测试、前端构建 | 只修阻断项 | 只修阻断项 | 汇总 P0/P1 |
| 06:30–08:15 | 浏览器回归与最终验收 | 回归支持 | 回归支持 | 最终只读复核 |
| 08:15 | 停止新增功能 | 停止新增功能 | 停止新增功能 | 只确认阻断项 |
| 09:00 | 只汇总待确认事项；若无则“无待确认事项” | 不单独汇报 | 不单独汇报 | 不单独汇报 |

### 阶段 3B：空间冲突事实闭环（2026-09-06，1 个工作日）

- 补齐所有 PostGIS 边界、走廊、时间和高度测试。
- 完成空域/冲突接口以及飞行计划页地图接线。
- 固化 `LEGAL/ILLEGAL/UNDETERMINED` local 演示样例，但不称为生产规则。

### 阶段 3C：合法性读取与前端整域切换（2026-09-07，1 个工作日）

- 完成已保存研判历史/详情接口。
- 移除合法性页面中的竞争 Mock 计算。
- 完成失败态、XSS、刷新、后端断开和按钮禁用验收。

### 阶段 3D：全量回归与交付（2026-09-08，0.5–1 个工作日）

- 完整 H2、PostgreSQL/PostGIS、Maven package、前端 build/scan/falsify。
- 真实浏览器完整路径与三个视口验收。
- 审查者最终复核，领导仅修阻断项并统一提交。

在依赖不阻断的情况下，完整阶段 3 目标完成时间为北京时间 **2026-09-08 18:00 前**；如果关键业务口径未确认，系统仍可交付 `UNDETERMINED` 的只读基础，但不得宣称生产合法性自动判定完成。

## 8. 人工可测试时间点

- **阶段 3A 后：** 可点“飞行计划”页面，测试后端计划列表、筛选、分页、详情和航线查看；若最小接线未达到门槛，则只开放 API 验收，不开放假按钮。
- **阶段 3B 后：** 可点计划与地图对象，查看空域边界和时空冲突事实。
- **阶段 3C 后：** 可点“合法性研判”，查看 local 的合法、非法、不可判定三类已保存结果；所有写按钮仍禁用。
- **阶段 3D 后：** 可按完整浏览器路径验收刷新、错误、权限差异和后端断开行为。

## 9. 明早 09:00 只允许汇总的待确认事项

以下事项不阻塞只读基础建表和 `UNDETERMINED` 结果，但会阻塞生产合法/非法自动判定：

1. 权威计划、航线、空域来源，样例载荷，增量同步、删除和来源完整性水位。
2. 正式计划状态码，以及外部计划 ID 唯一范围。
3. 跨行政区航线/空域的数据范围归属与授权方式。
4. 航线走廊宽度是全宽还是半宽，是否另有容差。
5. 空域边界接触是否算侵入，以及版本有效期是否允许重叠。
6. 空域类型字典和“任何计划均无权批准”的正式属性。
7. AGL/AMSL 的数据来源、转换依据及是否具备可信 DEM。
8. 计划匹配维度、时间/空间/高度容差、证据充分阈值和最终合法性枚举。
9. 规则生效、废止、追溯重算、人工修订和结果替代制度。
10. 飞手、执照、审批主体/时间等字段是否纳入本系统，以及权限和脱敏要求。

如 09:00 前其中任何一项已有明确结论，只从清单删除，不额外写进进度汇报。

## 10. 完成判定

只有同时满足以下条件才可说“阶段 3 完成”：

- 标准 API、权限、数据范围、版本和敏感字段约束全部落实。
- local/test 数据固定，生产与 `production,local` 均零演示数据。
- H2 业务契约测试和真实 PostgreSQL/PostGIS 空间测试均实际通过。
- 飞行计划和合法性页面不再用 `window.MOCK` 生成真实列表或结论。
- 页面 API 失败不回退 Mock，写按钮不伪造成功。
- 前端 build、scan、falsify、浏览器路径和 `git diff --check` 通过。
- 审查者无 P0/P1 阻断项，领导只提交阶段 3 文件。

若只达到明早 09:00 边界，状态必须写成“阶段 3A 完成/阶段 3 未完成”，不得简写为“阶段 3 完成”。
