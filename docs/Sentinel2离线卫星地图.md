# 东营 Sentinel-2 离线卫星地图

采用 Copernicus 2026 年第二季度官方 Sentinel-2 拼接影像，B04/B03/B02 合成自然彩色，原始分辨率 10 米。地图运行时只访问本机或内网资源；Copernicus 账号仅用于制包阶段下载原始影像，不能进入前端、地图包、Git 或部署配置。

本文是制作与部署流程，不是已经取得真实影像或完成运行验收的证明。实际数据日期、来源、SHA-256 和缺测比例以生成包中的 `sources/sentinel2-provenance.json` 为准；真实影像检查与启用结果须另行记录。

## 数据与许可

- 官方集合：`sentinel-2-global-mosaics`，时间段 `2026-04-01T00:00:00Z/2026-06-30T23:59:59Z`。季度拼接不代表某一天的实拍，也不是实时卫星图。
- 范围：`[117.914, 36.737, 119.508, 38.356]`，业务经纬度保持 WGS84。
- 当前官方目录返回 9 个产品、27 个 RGB 文件，约 4.48 GiB。目录由脚本现场查询，完整 ID 和下载地址保存在工作目录 `catalog.json`，不能用合成测试数据替代。
- [官方下载说明](https://documentation.dataspace.copernicus.eu/APIs/S3.html)、[Sentinel 数据许可](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)。保留 `Contains modified Copernicus Sentinel data 2026` 署名。原有 OSM、Protomaps、字体和图标许可继续随包提供。
- 使用免费 CDSE 数据端点 `https://eodata.dataspace.copernicus.eu`，不使用收费的其他云端点或抓取第三方在线底图。

## 制作环境

工具位于 `dongying-vue/tools/build-sentinel2-map.py`。需要 Python 3.12、GDAL 3.12、numpy、Pillow、boto3，推荐独立 conda-forge 环境。当前本机制图环境为 `E:\codex-map-work\gdal-env`；内网运行地图不需要安装这些软件。

可在另一台准备数据的机器上使用 micromamba 创建环境：

```powershell
micromamba create -y -p E:\codex-map-work\gdal-env -c conda-forge python=3.12 gdal=3.12 numpy pillow boto3
```

Windows 用户目录有非 ASCII 字符时，可直接调用该环境的解释器。仅为当前终端设置 PATH，脚本会定位环境中的 GDAL/PROJ 数据文件：

```powershell
$env:PATH = 'E:\codex-map-work\gdal-env;E:\codex-map-work\gdal-env\Library\bin;E:\codex-map-work\gdal-env\Scripts;' + $env:PATH
$mapPython = 'E:\codex-map-work\gdal-env\python.exe'
$mapBuilder = 'E:\rwurenji\_rong\dongying-vue\tools\build-sentinel2-map.py'
$mapWork = 'E:\codex-map-work\sentinel2-2026q2'
& $mapPython $mapBuilder catalog --work-dir $mapWork
```

## 账号与下载

1. 免费注册 Copernicus，点击邮箱里的激活链接，再登录。仅显示“Thank you for signing up”不代表已激活或已取得下载权限。
2. 在[官方 S3 凭据管理页](https://eodata-s3keysmanager.dataspace.copernicus.eu/)登录，创建下载凭据，选择满足本次下载的有效期。由账号持有人完成凭据创建；不要在聊天、截图或日志里发送密钥。
3. 将 Access key 和 Secret key 保存到仓库外的本地 JSON，例如 `E:\codex-map-work\private\cdse-download.json`。字段如下，值由账号持有人填写：

```json
{"access_key":"填写官方 Access key","secret_key":"填写官方 Secret key"}
```

4. 下载命令只传文件路径，不将密钥放到命令行：

```powershell
& $mapPython $mapBuilder download --work-dir $mapWork --credentials-file 'E:\codex-map-work\private\cdse-download.json'
if ($LASTEXITCODE -ne 0) { throw '影像下载未完成' }
```

也支持 `CDSE_S3_ACCESS_KEY` / `CDSE_S3_SECRET_KEY` 进程环境变量。原始文件置于工作目录 `raw/<product>/B04.tif` 等路径，每个文件附来源、大小、SHA-256 receipt。重试会校验已有完整文件，下载失败不切换地图。制包时再次核对 receipt，发现同大小损坏也会停止。数据准备完成后，账号持有人可在官方页面撤销本次下载凭据。

## 生成独立地图版本

保留现有矢量包并使用全新的输出路径：

```powershell
& $mapPython $mapBuilder package --work-dir $mapWork --base 'E:\rwurenji\_rong\map-data\dongying-dev' --out 'E:\rwurenji\_rong\map-data\dongying-sentinel2-2026q2'
if ($LASTEXITCODE -ne 0) { throw '地图包制作未完成，不能上传启用' }
node 'E:\rwurenji\_rong\dongying-vue\tools\check-map-package.cjs' 'E:\rwurenji\_rong\map-data\dongying-sentinel2-2026q2'
```

处理参数：统一 RGB 拉伸范围 0–3000，指数 0.85；双线性投影到 EPSG:3857；原始 nodata=-32768，三波段均有效才显示；无数据像素保留透明。GDAL 生成 XYZ Z0–Z13、512×512 WebP、质量85的 2442 张瓦片，低级别使用 average。高倍缩放使用已有瓦片放大，不增加原始影像细节。

输出目录及同名 ZIP 必须尚不存在；脚本拒绝覆盖旧版本。失败后保留现场，修正问题后用新的输出版本名重试；原始下载可复用，瓦片中间目录每次独立。工作目录包含原始影像和中间数据，须预留约 15 GiB 以上空闲空间，最终占用以实际输出为准。

包内包含原矢量道路、地名、字体、图标及其许可，新影像、来源记录与完整 SHA-256 清单；不携带下载凭据或旧 EOX 影像。文件数含清单必须不超过10000，解压总量含清单不超过2 GiB，ZIP不超过512 MiB。脚本完成后也不自动启用。

新 manifest 的影像字段：

```json
"imagery": {
  "tiles": "./imagery/{z}/{x}/{y}.webp",
  "tileSize": 512,
  "minZoom": 0,
  "maxZoom": 13,
  "attribution": "Contains modified Copernicus Sentinel data 2026"
}
```

旧包可不声明 imagery；旧影像包不声明 tileSize 时按256处理。后台校验路径、全量校验和、完整XYZ范围、PNG/WebP类型与尺寸，原权限和配额保持。文件头校验不能代替真实像素与地理对齐检查。

## 上传、启用及回滚

使用现有后台“地图资源管理”的上传、校验、启用入口。新包校验通过后才启用；原地图包保留。回滚时从同一页面重新启用上一已校验版本，不覆盖旧文件，不手工改数据库。

管理端、业务前台、大屏和模拟器必须映射到同一地图数据根目录，读取同一后台运行指针。静态服务须支持 `.webp` 的 `image/webp`、PMTiles Range/206；缺失文件返回404，不可回退为SPA首页。版本文件可长期缓存，运行指针必须重新校验缓存。

部署时应在后端和地图静态服务的启动环境显式设置 `$env:MAP_DATA_DIR='E:\rwurenji\_rong\map-data'`，系统服务或容器应保存到对应服务配置。数据库配置继续使用本机原配置，不能为地图部署切换数据库或开启种子。

本机另已将 `E:\houtaiguanlii\server\data\map-data` 设置为指向上述共用目录的 Windows Junction，使后端使用默认目录启动时也读写同一地图。建立链接前，该目录只有一份运行指针，已完整保留到同级 `map-data-before-shared-20261021-0340`；原 `dongying-dev` 和纳管的矢量版本均保留。其他机器不依赖本机链接，应显式配置自己的共用目录。该链接指向实际地图资源，不能作为临时目录递归清理。

影像保持自然色、二维、北向上，路网、地名及业务图层继续显示。影像加载失败时提示并回退到包内矢量底图，重试重新加载；不调用公网备用地图。三维空域编辑器、设备范围和业务坐标不在本次修改范围。

## 真实数据验收记录

以下项目须在取得官方影像后逐项记录，不能用合成制包测试或单元测试代替：

1. 记录实际产品清单、下载完成时间、源文件 SHA-256、有效像素及缺测比例；检查东营城区、农田、黄河和海岸的自然色、接缝、透明缺测和黑边。
2. 实际浏览器平移、缩放到高倍率、选择设备，核对影像与道路、设备、航线的坐标一致，检查前台、大屏、后台与模拟器。
3. 阻断公网请求、使用清空缓存的新浏览器上下文重载，确认地图、字体、图标、Worker和脚本均来自本机/内网；记录请求和错误。
4. 在隔离测试中验证旧矢量包、新影像包、缺失瓦片、错误清单；后台实际执行上传、启用、回滚并读取结果。测试文件不能混入实际交付包。
5. 构建当前前后端，重启后运行后台仓库 `scripts/check-local-startup.mjs --business-dir E:\rwurenji\_rong\dongying-vue`，记录本次时间、退出码和真实账号操作结果；验收保持 `app.dev-seed.enabled=false`。

只有这些项目完成后，才能将新版本标记为“已启用并通过离线验收”。
