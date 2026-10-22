#!/usr/bin/env python3
"""Prepare a free, offline Sentinel-2 map. Never changes the active map pointer.

Use an isolated Python environment with GDAL 3.12, numpy, Pillow and boto3.
catalog needs no account; download uses CDSE_S3_ACCESS_KEY/CDSE_S3_SECRET_KEY
or a local --credentials-file containing access_key and secret_key. Secrets
are never copied to work receipts, map packages or command output.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlencode, urlparse
from urllib.request import urlopen
import zipfile

BOUNDS = [117.914, 36.737, 119.508, 38.356]
COLLECTION = "sentinel-2-global-mosaics"
STAC = "https://stac.dataspace.copernicus.eu/v1"
PERIOD = "2026-04-01T00:00:00Z/2026-06-30T23:59:59Z"
BANDS = ("B04", "B03", "B02")
ATTRIBUTION = "Contains modified Copernicus Sentinel data 2026"
LICENSE_URL = "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice"
MAX_ZIP = 512 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def package_path(root, name):
    """Accept one canonical package-relative path, including on Windows."""
    if not isinstance(name, str) or not name or any(c in name for c in ("\\", ":", "%", "\0")):
        raise ValueError("Invalid package path")
    if any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in name.split("/")):
        raise ValueError("Package path must be canonical and relative")
    root = root.resolve()
    result = (root / name).resolve()
    if root not in result.parents:
        raise ValueError("Package path escapes its directory")
    return result


def tile_indices(bounds, zoom):
    n = 2 ** zoom
    def x(lon):
        return max(0, min(n - 1, math.floor((lon + 180) / 360 * n)))
    def y(lat):
        lat = max(-85.05112878, min(85.05112878, lat))
        return max(0, min(n - 1, math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)))
    for tx in range(x(bounds[0]), x(bounds[2]) + 1):
        for ty in range(y(bounds[3]), y(bounds[1]) + 1):
            yield tx, ty


def catalog(work):
    query = urlencode({"collections": COLLECTION, "bbox": ",".join(map(str, BOUNDS)), "datetime": PERIOD, "limit": 100})
    next_url = STAC + "/search?" + query
    records = {}
    visited = set()
    while next_url:
        if next_url in visited or len(visited) >= 20 or not next_url.startswith(STAC + "/"):
            raise ValueError("Unexpected catalogue pagination")
        visited.add(next_url)
        with urlopen(next_url, timeout=60) as response:
            result = json.load(response)
        for item in result.get("features", []):
            name = item["id"]
            if not name.startswith("Sentinel-2_mosaic_2026_Q2_") or Path(name).name != name or "/" in name or "\\" in name:
                raise ValueError("Unexpected product identity")
            assets = {}
            for band in BANDS:
                source = item["assets"][band]
                href = source["href"]
                expected = f"s3://eodata/Global-Mosaics/Sentinel-2/S2MSI_L3__MCQ/2026/04/01/{name}/{band}.tif"
                if href != expected or source.get("gsd", item["properties"].get("gsd")) != 10:
                    raise ValueError("Unexpected product asset or resolution")
                assets[band] = {"href": href, "bytes": source["file:size"], "nodata": source.get("nodata", -32768)}
            records[name] = {"id": name, "bbox": item["bbox"], "assets": assets,
                             "source": f"{STAC}/collections/{COLLECTION}/items/{name}"}
        next_url = next((link["href"] for link in result.get("links", []) if link["rel"] == "next"), None)
    if not records:
        raise ValueError("No 2026 Q2 products found; the existing map remains active")
    value = {"collection": COLLECTION, "period": PERIOD, "bounds": BOUNDS, "resolution_m": 10,
             "retrieved_at": datetime.now(timezone.utc).isoformat(), "license": LICENSE_URL,
             "items": [records[key] for key in sorted(records)]}
    save_json(work / "catalog.json", value)
    print(f"Catalogue: {len(records)} products, {sum(a['bytes'] for r in records.values() for a in r['assets'].values()) / 1024**3:.2f} GiB RGB data")


def read_catalog(work):
    value = json.loads((work / "catalog.json").read_text(encoding="utf-8"))
    if value.get("collection") != COLLECTION or value.get("period") != PERIOD or value.get("bounds") != BOUNDS:
        raise ValueError("Catalogue does not describe the approved area and period")
    if not value.get("items") or len(value["items"]) > 100:
        raise ValueError("Invalid product list")
    for item in value["items"]:
        name = item["id"]
        if Path(name).name != name or any(c in name for c in ("/", "\\", ":")):
            raise ValueError("Invalid product directory")
        for band in BANDS:
            expected = f"s3://eodata/Global-Mosaics/Sentinel-2/S2MSI_L3__MCQ/2026/04/01/{name}/{band}.tif"
            if item["assets"][band]["href"] != expected:
                raise ValueError("Asset outside the selected official collection")
    return value


def download(work, credentials_file):
    import boto3
    from botocore.config import Config
    values = json.loads(credentials_file.read_text(encoding="utf-8")) if credentials_file else {}
    access = values.get("access_key") or os.environ.get("CDSE_S3_ACCESS_KEY")
    secret = values.get("secret_key") or os.environ.get("CDSE_S3_SECRET_KEY")
    if not access or not secret:
        raise ValueError("CDSE download needs a free account's S3 credentials; use environment variables or --credentials-file outside the repository")
    client = boto3.client("s3", endpoint_url="https://eodata.dataspace.copernicus.eu",
                          aws_access_key_id=access, aws_secret_access_key=secret,
                          region_name="default", config=Config(signature_version="s3v4", retries={"max_attempts": 5}))
    value = read_catalog(work)
    jobs = [(item, band) for item in value["items"] for band in BANDS]
    def one(job):
        item, band = job
        path = work / "raw" / item["id"] / f"{band}.tif"
        receipt = path.with_suffix(".receipt.json")
        asset = item["assets"][band]
        if path.is_file() and receipt.is_file():
            old = json.loads(receipt.read_text(encoding="utf-8"))
            if (path.stat().st_size == asset["bytes"] and old.get("source") == asset["href"]
                    and old.get("bytes") == asset["bytes"] and old.get("sha256") == digest(path)):
                print(f"Verified cached {item['id']} {band}", flush=True)
                return
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".partial")
        source = urlparse(asset["href"])
        try:
            client.download_file(source.netloc, source.path.lstrip("/"), str(partial))
        except Exception:
            raise RuntimeError(f"Download failed for {item['id']} {band}; check account access/network and retry") from None
        if partial.stat().st_size != asset["bytes"]:
            raise ValueError(f"Incomplete download: {item['id']} {band}")
        partial.replace(path)
        save_json(receipt, {"source": asset["href"], "bytes": path.stat().st_size, "sha256": digest(path)})
        print(f"Downloaded {item['id']} {band}", flush=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(one, jobs))


def make_rgba(work, value):
    # Standalone conda environments on Windows do not run activation hooks.
    # Locate data files within this interpreter, without editing system settings.
    for variable, folder in (("GDAL_DATA", "gdal"), ("PROJ_DATA", "proj")):
        for candidate in (Path(sys.prefix) / "Library" / "share" / folder, Path(sys.prefix) / "share" / folder):
            if not os.environ.get(variable) and candidate.is_dir():
                os.environ[variable] = str(candidate)
    from osgeo import gdal
    import numpy as np
    gdal.UseExceptions()
    processing = work / "processing"
    processing.mkdir(exist_ok=True)
    radius = 6378137
    west, south, east, north = BOUNDS
    bounds_m = [radius * math.radians(west), radius * math.asinh(math.tan(math.radians(south))),
                radius * math.radians(east), radius * math.asinh(math.tan(math.radians(north)))]
    resolution = 2 * math.pi * radius / (512 * 2**13)
    outputs, inputs = [], []
    for band in BANDS:
        files = []
        for item in value["items"]:
            path = work / "raw" / item["id"] / f"{band}.tif"
            asset = item["assets"][band]
            if not path.is_file() or path.stat().st_size != asset["bytes"]:
                raise ValueError(f"Missing or incomplete source: {item['id']} {band}")
            source_sha = digest(path)
            receipt = path.with_suffix(".receipt.json")
            if not receipt.is_file():
                raise ValueError(f"Missing verified download receipt: {item['id']} {band}")
            downloaded = json.loads(receipt.read_text(encoding="utf-8"))
            if (downloaded.get("source") != asset["href"] or downloaded.get("bytes") != asset["bytes"]
                    or downloaded.get("sha256") != source_sha):
                raise ValueError(f"Source receipt mismatch: {item['id']} {band}; download again")
            ds = gdal.Open(str(path))
            if ds.RasterCount != 1 or abs(ds.GetGeoTransform()[1] - 10) > 0.001 or abs(ds.GetGeoTransform()[5] + 10) > 0.001:
                raise ValueError(f"Source is not the expected 10 m band: {item['id']} {band}")
            if ds.GetRasterBand(1).GetNoDataValue() != -32768:
                raise ValueError("Unexpected nodata metadata; do not guess its value")
            ds = None
            files.append(str(path))
            inputs.append({"product": item["id"], "band": band, "bytes": path.stat().st_size, "sha256": source_sha})
        out = processing / f"{band}-3857.tif"
        gdal.Warp(str(out), files, dstSRS="EPSG:3857", outputBounds=bounds_m,
                  xRes=resolution, yRes=resolution, targetAlignedPixels=True,
                  srcNodata=-32768, dstNodata=-32768, outputType=gdal.GDT_Int16,
                  resampleAlg="bilinear", multithread=True,
                  creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "BIGTIFF=IF_SAFER"])
        outputs.append(gdal.Open(str(out)))
    reference = outputs[0]
    rgba = processing / "true-color-rgba.tif"
    target = gdal.GetDriverByName("GTiff").Create(str(rgba), reference.RasterXSize, reference.RasterYSize,
                                                  4, gdal.GDT_Byte, options=["TILED=YES", "COMPRESS=DEFLATE", "BIGTIFF=IF_SAFER"])
    target.SetGeoTransform(reference.GetGeoTransform())
    target.SetProjection(reference.GetProjection())
    for i, interpretation in enumerate((gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand, gdal.GCI_AlphaBand), 1):
        target.GetRasterBand(i).SetColorInterpretation(interpretation)
    valid_count = 0
    for y in range(0, reference.RasterYSize, 1024):
        for x in range(0, reference.RasterXSize, 1024):
            width, height = min(1024, reference.RasterXSize - x), min(1024, reference.RasterYSize - y)
            raw = np.stack([ds.ReadAsArray(x, y, width, height) for ds in outputs])
            valid = np.all(raw != -32768, axis=0)
            valid_count += int(valid.sum())
            rgb = np.rint(np.clip(raw.astype(np.float32) / 3000, 0, 1) ** 0.85 * 255).astype(np.uint8)
            rgb[:, ~valid] = 0
            for i in range(3):
                target.GetRasterBand(i + 1).WriteArray(rgb[i], x, y)
            target.GetRasterBand(4).WriteArray(valid.astype(np.uint8) * 255, x, y)
    total = reference.RasterXSize * reference.RasterYSize
    target.FlushCache()
    target = None
    outputs = []
    if not valid_count:
        raise ValueError("No valid imagery pixels; refusing to build an empty satellite map")
    provenance = {**value, "input_files": inputs, "attribution": ATTRIBUTION,
                  "processing": {"gdal": gdal.VersionInfo("RELEASE_NAME"), "rgb_bands": BANDS,
                                 "reflectance_range": [0, 3000], "exponent": 0.85,
                                 "projection": "EPSG:3857", "resampling": "bilinear", "nodata": -32768},
                  "coverage": {"valid_pixels": valid_count, "total_pixels": total,
                               "nodata_fraction": 1 - valid_count / total, "nodata_display": "transparent"}}
    save_json(work / "provenance.json", provenance)
    return rgba


def checksums(root):
    records = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Symbolic links are not allowed in map packages")
        if path.is_file() and path != root / "checksums.json":
            records.append({"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)})
    save_json(root / "checksums.json", {"algorithm": "SHA-256", "files": records})
    expanded = sum(item["bytes"] for item in records) + (root / "checksums.json").stat().st_size
    if len(records) + 1 > 10000 or expanded > MAX_EXPANDED:
        raise ValueError("Map package exceeds the existing file count or expanded size limit")


def package(work, base, output):
    from PIL import Image
    if output.exists() or output.with_suffix(".zip").exists():
        raise ValueError("Choose a new output version; existing files are never overwritten")
    base = base.resolve()
    output = output.resolve()
    if base == output or base in output.parents:
        raise ValueError("Output cannot be inside the base package")
    manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("bounds") != BOUNDS or manifest.get("coordinateSystem") != "WGS84":
        raise ValueError("Base map bounds/coordinates differ from the selected imagery")
    declared = json.loads((base / "checksums.json").read_text(encoding="utf-8"))
    if declared.get("algorithm") != "SHA-256":
        raise ValueError("Base package needs SHA-256 checksums")
    seen = set()
    for item in declared["files"]:
        path = package_path(base, item["path"])
        identity = str(path).casefold()
        if identity in seen:
            raise ValueError("Duplicate base package path")
        seen.add(identity)
        if not path.is_file() or path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError("Base package checksum mismatch")
    for path in base.rglob("*"):
        if path.is_symlink():
            raise ValueError("Base package cannot contain symbolic links")
    value = read_catalog(work)
    rgba = make_rgba(work, value)
    # A failed render can be retried without deleting raw sources or old output.
    tiles = Path(tempfile.mkdtemp(prefix="tiles-512-z13-", dir=work))
    subprocess.run([sys.executable, "-m", "osgeo_utils.gdal2tiles", "--xyz", "--tilesize=512", "--zoom=0-13",
                    "--tiledriver=WEBP", "--webp-quality=85", "--processes=4", "--resampling=average",
                    "--webviewer=none", str(rgba), str(tiles)], check=True)
    expected = [Path(str(z), str(x), f"{y}.webp") for z in range(14) for x, y in tile_indices(BOUNDS, z)]
    for relative in expected:
        with Image.open(tiles / relative) as tile:
            if tile.format != "WEBP" or tile.size != (512, 512):
                raise ValueError(f"Invalid imagery tile: {relative}")
            tile.load()
    # Copy only the base package's audited files; never carry old imagery over.
    output.mkdir(parents=True)
    old_template = manifest.get("imagery", {}).get("tiles", "./imagery/{z}/{x}/{y}.jpg")
    old_prefix = old_template.split("{z}")[0].removeprefix("./")
    for item in declared["files"]:
        relative = Path(item["path"])
        if relative.as_posix().startswith(old_prefix) or relative.as_posix() in ("manifest.json", "SOURCES.txt"):
            continue
        dest = package_path(output, item["path"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(base / relative, dest)
    for relative in expected:
        dest = output / "imagery" / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tiles / relative, dest)
    manifest.update({"name": "东营2026年卫星底图", "dataVersion": "sentinel2-2026Q2", "cityCode": "370500", "cityName": "东营市",
                     "imagery": {"tiles": "./imagery/{z}/{x}/{y}.webp", "tileSize": 512,
                                 "minZoom": 0, "maxZoom": 13, "attribution": ATTRIBUTION}})
    save_json(output / "manifest.json", manifest)
    provenance = json.loads((work / "provenance.json").read_text(encoding="utf-8"))
    provenance["tiles"] = {"count": len(expected), "tile_size": 512, "scheme": "xyz", "zoom": [0, 13], "format": "webp", "quality": 85}
    provenance["base_manifest_sha256"] = digest(base / "manifest.json")
    save_json(output / "sources" / "sentinel2-provenance.json", provenance)
    (output / "SOURCES.txt").write_text(
        "东营二维离线卫星地图。影像：Copernicus Sentinel-2 2026年第二季度官方拼接，10米。\n"
        + ATTRIBUTION + "\n许可与署名说明：" + LICENSE_URL + "\n"
        + "源影像日期、产品ID、文件SHA-256、处理参数和缺测比例见 sources/sentinel2-provenance.json。\n"
        + "影像超出原始分辨率的缩放仅为放大，不增加地物细节；缺测区域透明。\n"
        + "矢量基础包版本：" + str(json.loads((base / "manifest.json").read_text(encoding="utf-8"))["dataVersion"]) + "。\n"
        + "© OpenStreetMap contributors / Protomaps。OSM：ODbL https://www.openstreetmap.org/copyright\n"
        + "Protomaps样式及图标：https://github.com/protomaps/basemaps；字体和图标许可保留在 fonts/ 和 sources/。\n"
        + "本包不包含旧EOX影像；完整文件校验见 checksums.json。\n", encoding="utf-8")
    checksums(output)
    zip_path = output.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(output).as_posix())
    if zip_path.stat().st_size > MAX_ZIP:
        raise ValueError("Generated ZIP exceeds 512 MiB; do not upload or activate it")
    print(f"Prepared {len(expected)} tiles; ZIP {zip_path.stat().st_size / 1024**2:.1f} MiB. Not activated: {zip_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("catalog", "download", "package"))
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    if args.command == "catalog":
        catalog(work)
    elif args.command == "download":
        download(work, args.credentials_file)
    else:
        if not args.base or not args.out:
            parser.error("package requires --base and --out")
        package(work, args.base, args.out)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Stopped: {error}", file=sys.stderr)
        sys.exit(1)
