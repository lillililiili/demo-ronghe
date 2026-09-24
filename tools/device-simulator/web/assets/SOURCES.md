# 图标来源与用途

实现版：用户确认 5D-A 为 5G-A 后，使用项目 `5ga.svg` 正式图标。

项目自有业务 SVG，直接复制自 `dongying-vue/public/assets/img/business/`：

| 文件 | 用途 |
| --- | --- |
| radar.svg | 雷达设备 |
| tdoa.svg | TDOA 设备 |
| rid.svg | Remote ID 设备 |
| uav.svg | 无人机目标 |
| bird.svg | 鸟群目标 |
| balloon.svg | 气球目标 |
| fusion.svg | 工具品牌标记 |

通用类型图标静态导出自仓库已有的 `@vicons/ionicons5`（Ionicons，MIT），没有新增运行依赖：

| 文件 | 原组件 | 用途 |
| --- | --- | --- |
| area.svg | MapOutline | 区域、进入限飞区域 |
| route.svg | GitBranchOutline | 航线、偏离路线 |
| document.svg | DocumentTextOutline | 无匹配飞行计划 |
| height.svg | ArrowUpOutline | 超高飞行 |
| clock.svg | TimeOutline | 超出计划时段 |
| offline.svg | WifiOutline | 设备连接状态场景（名称说明离线） |
| fault.svg | BuildOutline | 设备故障 |

所有图标均为矢量原稿或组件的直接导出；未使用截图裁片、表情或生成图片替代控件。底图是独立绘制的示意几何，界面持续标注非真实地理数据。

设备类型更新：`eo.svg` 直接复制项目 `eo.svg`；`5da.svg` 直接复制项目 `unknown-device.svg`，仅作未确认型号的通用标记；`weather.svg` 静态导出自已有 Ionicons `PartlySunnyOutline`。原雷达和 Remote ID 图标保留用于已保存草稿。
