# 可见光实拍回放素材

来源：Fredrik Svanström 等，Halmstad Drone Detection Dataset。

- 项目：<https://github.com/DroneDetectionThesis/Drone-detection-dataset>
- 固定版本：`442d0c6750708cc221636f7a1fd31cbd8cb0aeb8`
- 原视频：`Data/Video_V/V_DRONE_017.mp4`，640×512，30fps，328帧，约10.93秒。
- 原标注：`Data/Video_V/V_DRONE_017_LABELS.mat`。
- 授权：项目CC0-1.0，完整文本见同目录LICENSE。README明确允许下载、使用和编辑。
- 引用：Svanström F, Alonso-Fernandez F and Englund C. (2021). A Dataset for Multi-Sensor Drone Detection.

此处保留无框原文件。`annotations.json` 记录原视频SHA256、原标注SHA256、固定来源版本、帧数和逐帧矩形。MATLAB矩形原点从1基转换为0基，宽高保持；取唯一声明328行的逐帧标注表，不能把同文件MCOS元信息里的空值误当视频第一帧。

模拟器显式选择原片的偶数帧输出15fps；保持原640×512像素，在960×540画布中水平居中。原始流不画目标框；AI流按同一帧标注画框。底部28像素为回放标识及媒体时钟校验条码，不覆盖无人机。框元数据与真正编码帧同源，取模用于10.93秒循环；实际媒体时间持续递增，不在循环点归零。

这是用于本地QA的实拍录像回放。AI框来自人工标注，不代表现场识别模型推理。平台目标关联仍须由当前任务及已验证模拟观测建立；不能用于真实告警核实依据。任意外部视频不会自动使用这些标注。

运行期不依赖SciPy或mcos-decoder，不访问素材网站。原视频和标注校验不一致时拒绝使用。
