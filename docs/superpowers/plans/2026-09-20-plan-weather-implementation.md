# 飞行计划、天气预报与天气传感器实施

依据：`docs/designs/2026-09-20-plan-weather/设计说明.md` 当前精简稿。仅在两个仓库本地 main 修改，保留已有改动，不提交无关文件。

## 已知边界

上游计划系统/推拉方式、天气服务商和传感器协议尚未提供，已向用户询问。本次先落地页面、服务器持久化配置与待接入设备档案；不得生成虚假接收记录、测试成功或气象读数。实际适配与联调依赖上述资料，不把“已保存”显示成“已启用”。不新增现场实测页签、计划关联站点或风险规则。

## 任务

1. 后端配置：在同级 houtaiguanli 的 server 新增 integrationconfig 模块及独立 Flyway 迁移。GET/PUT `/api/v1/external-interface-configs/{FLIGHT_PLAN|WEATHER_FORECAST}`，沿用 interfaces.read/op；配置草稿版本校验、审计、凭据引用校验。返回明确 NOT_CONFIGURED/AWAITING_ADAPTER，当前不开放启用/虚假测试。
2. 业务天气展示：`dongying-vue/src/pages/FlightsPage.vue` 增加计划信息/天气预报切换，新增 `PlanWeatherForecast.vue` 和 service。GET `/api/v1/flight-plans/{id}/weather-forecast` 必须先用原 FlightReadService 验证权限和数据范围。页面处理未配置、待接入、失败、空、过期，切换计划不残留数据。保留原有计划与风险动作。
3. 后台配置页：同级 ruoyi-ui 增加 InterfacesView 和 API，导航使用已有 interfaces 菜单/权限；飞行计划、天气两个配置表单及天气传感器管理入口，配置从服务端读写。字段由当前设计收敛，未确认项留空，无演示状态开关。
4. 天气传感器：在已有设备台账登记 weather_sensor，默认停用且真实来源状态未知。新增专用登记/编辑接口与表单，不绑定虚构设备协议，不允许启用未实现适配器。详情显示尚无气象观测，未来字段能力由实际协议决定。
5. 验证：后端接口权限、版本冲突、字段校验、持久化、设备不可假启用；两套前端构建/规定扫描与测试，浏览器检查实际入口及窄屏；两个仓库 diff --check。同步 README 和接口文档，明确真实通道/设备未联调。

## 进度

- [x] 后端接口与配置草稿持久化（真实接收/采集适配仍待协议资料）
- [x] 业务天气展示与未接入状态
- [x] 后台配置与传感器台账登记
- [x] 验证、审阅、文档；具体证据见 `docs/飞行计划天气配置实施-2026-09-20.md`
