# 无人机融合感知与低空安全管理平台 · Demo

离线可点击演示（纯静态，无构建）。

## 启动

```bash
node serve.js
```

打开 http://localhost:8899 。离线地图瓦片包（`dongying-demo/assets/tiles/`，1.5GB）不入库，需另行获取解压。

## 验证工具

```bash
node tools/scan.js      # 源码合规扫描
node tools/falsify.js   # 断言证伪
```
