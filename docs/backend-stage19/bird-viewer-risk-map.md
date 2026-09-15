# 飞行风险列表与异物地图（2026-09-14）

> 2026-09-15 仓库归属：本文后端 `server/` 路径指同级 `../houtaiguanli/server/`；历史验证记录保留原日期。迁入后台后的迁移版本与验证结果以后台 `docs/新后端迁移记录.md` 为准。

用户指定参考 [Robin Radar Bird Viewer](https://www.robinradar.com/bird-viewer-for-aviation)，主要借鉴位置标记、轨迹和事件分布的阅读方式。没有复制品牌、图片或产品素材，也不宣称实现了雷达设备的探测能力。

## 页面变化

入口：飞行活动管理 → 全部风险事件。

- 左侧采用“全部 / 异物 / 气象”快捷分类，常用等级、状态筛选常驻；区域、时间、来源等放在折叠筛选内。选择即更新列表，排序合为下拉框，导出放进“更多”。高级筛选显示可清除标签。
- 事件卡缩小，标题旁集中显示风险等级和处理状态，去掉大块重复字段。详细依据、通知与回执仍在详情中查看。
- 选中鸟群时，地图显示鸟类图标、数量和事件位置；气球等其他异物使用中性点标记并写明名称。标记颜色表示风险等级，已通知不会把风险点变绿。
- 已保存航线走廊宽度可用时显示半透明走廊，异物与航线之间显示位置关系辅助线。时间、距离和高度取已有记录；缺失显示未知。
- “事件热区”显示当前页、相同区域、相同来源模式且有坐标的异物事件分布，每条记录权重相同。它不是雷达连续探测热图，也不是鸟群实际活动边界或数量估算。无坐标时按钮禁用。
- 有至少两个有效关联目标轨迹点时才显示轨迹开关及逐点回放，支持前一点、后一点、播放、暂停和重播。回放的是现有接口提供的最近轨迹片段，不是完整事件历史；超过 30 秒的采样间隙断开，不插值。
- 图例在地图右下角，默认折叠，采用小型半透明毛玻璃样式。

## 数据与流程边界

LocalPendingPlanDemoSeeder 在 `seed-stage3-source` 下新增 `pending-plan-notice-demo-{1/2/3}-map-v1` 三条专属 mock 地图样例，插入时提供固定 WGS-84 点位，稳定来源编号防止重启重复添加。旧的无坐标记录不改动，已有风险状态、核验历史、通知和回执不覆盖。不创建虚构轨迹或二十个鸟的位置。

核验、通知、权限与历史流程沿用现有接口。本轮没有新增业务接口、数据库迁移或依赖。保留已有气象地图表现和飞行计划状态逻辑。离开地图或切换风险时停止回放定时器。

## 代码变更说明

| 文件 | 函数/模块 | 页面作用 |
| --- | --- | --- |
| `dongying-vue/src/pages/FlightsPage.vue` | 筛选模板、riskRecords、setRiskSort、setRiskKind、clearRiskFilter | 压缩筛选和卡片，选择即查询 |
| 同上 | renderRiskMap、resetObjectMap、toggleObjectHeat、toggleObjectTrail、stepObjectTrail、toggleObjectPlayback、stopObjectPlayback | 联动事件位置、热区和有数据的轨迹回放，清理生命周期 |
| `dongying-vue/src/pages/flights/components/FlightRecordList.vue` | compact 属性、模板和样式 | 风险列表使用紧凑卡片，计划列表保留原模式 |
| `dongying-vue/src/pages/flights/objectRiskMap.js` | objectSnapshot、objectTrackPoints、drawObjectRisk | 校验坐标和时间、绘制已有位置及轨迹，不生成业务事实 |
| `dongying-vue/src/pages/flights/components/ObjectRiskMapInfo.vue` | 计算属性、模板和样式 | 异物标签、图层开关、回放操作和折叠图例 |
| `server/src/main/java/com/uav/lowaltitude/integration/mock/LocalPendingPlanDemoSeeder.java` | run、seedRisk | 幂等追加三条带坐标的地图模拟样例，保留旧记录 |

按用户要求不运行测试、前端构建或浏览器验收。`git diff --check` 通过。后端已执行 `./mvnw -Dmaven.test.skip=true package` 并完成重启，运行 PID 52823；启动日志和数据库确认三条 `-map-v1` 样例包含点位，旧样例的两条待通知、一条已通知状态保留。

首次部署尝试补旧坐标，被 `space_risk_fact` 的 append-only 保护阻止并导致启动失败，随后恢复旧包，再改为稳定新来源编号追加样例后部署成功。没有关闭触发器或修改旧事实。部署记录仅说明启动与数据写入结果，不作为业务测试或视觉验收。未实际发送通知或执行核验。
