# 无框鲜彩业务图标

2026-09-16 用户确认：全部设备、目标、设施图标采用无外框、无底座、无黑色填充的鲜彩独立图形。页面背景、布局、导航及通用操作图标保持现状。

来源：项目自有 SVG 矢量原稿，按本对话获准的两张“无框鲜彩版”AI 预览板制作。为了 20–34px 界面尺寸，细节做矢量简化；不是将预览板整图或文字裁成图标，也不是第三方图标包。没有嵌入位图、外部链接、字体、脚本或生产依赖。

- 原稿 / 生成器：`tools/build-business-icons.mjs`。
- 颜色唯一来源：`src/assets/css/tokens.css` 中 `--icon-*`。
- 规格：64×64 viewBox，透明背景，保留主体结构的渐变与浅色高光；无外围徽章、光晕、圆框或六边形。
- 修改原稿和 token 后执行 `node tools/build-business-icons.mjs`，再执行 `node tools/check-business-icons.cjs`。
- 列表 / 详情：`UI.deviceIcon`、`UI.targetIcon`、`UI.businessIcon`；地图：`UI.drawBusinessIcon`。普通 `UI.icon` 不自动换成彩色图标。
- 类别图形不根据在线/离线/风险等级重新染色。状态角标、选中下划线及历史提示由消费者单独绘制。
- 机巢仅映射已有机巢参考点，不新增控制功能。未知类型使用未知图形；不添加协议枚举中不存在的设备类型。

| 资产 | 语义 | 配色 token |
|---|---|---|
| `radar.svg` | 雷达 | `--icon-radar` |
| `eo.svg` | 光电 | `--icon-eo` |
| `tdoa.svg` | TDOA | `--icon-tdoa` |
| `aoa.svg` | AOA | `--icon-aoa` |
| `5ga.svg` | 5G-A | `--icon-5ga` |
| `spec.svg` | 频谱设备 | `--icon-spec` |
| `cm.svg` | 反制设备 | `--icon-cm` |
| `dec.svg` | 诱骗设备 | `--icon-dec` |
| `ifr.svg` | 干扰设备 | `--icon-ifr` |
| `cv.svg` | 指挥车 | `--icon-cv` |
| `isrs.svg` | 察打一体 | `--icon-isrs` |
| `dcd.svg` | 协议破解 | `--icon-dcd` |
| `bsc.svg` | 驱鸟炮 | `--icon-bsc` |
| `rid.svg` | RemoteID | `--icon-rid` |
| `fusion.svg` | 融合感知箱 | `--icon-fusion` |
| `uav.svg` | 无人机 | `--icon-uav` |
| `bird.svg` | 鸟类 | `--icon-bird` |
| `balloon.svg` | 气球（推断 subtype） | `--icon-balloon` |
| `kite.svg` | 风筝（推断 subtype） | `--icon-kite` |
| `lantern.svg` | 孔明灯（推断 subtype） | `--icon-lantern` |
| `nest.svg` | 机巢 | `--icon-nest` |
| `unknown.svg` | 未知目标 | `--icon-unknown` |
| `unknown-device.svg` | 未知设备 | `--icon-unknown-device` |

后续地图提亮：主体暗部提高至类别色的 93%，高光缩短，结构线从 3 提高至 3.8 viewBox 单位，增加贴合主体的 0.65 单位浅色细轮廓。SVG 自身没有光晕；当前报警红光由 Canvas/CSS 状态渲染，历史及无当前报警依据时不闪烁。
