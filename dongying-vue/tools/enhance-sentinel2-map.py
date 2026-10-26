#!/usr/bin/env python3
"""Build a separate enhanced Sentinel-2 offline package from original local data.

Uses the original georeferenced raster, never generative detail or downloaded tiles.
Does not upload, activate, replace, or delete an existing package.
"""
import argparse
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import numpy as np

spec = importlib.util.spec_from_file_location("sentinel_builder", Path(__file__).with_name("build-sentinel2-map.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

PARAMETERS = {"method": "luminance-unsharp", "kernel": [1, 4, 6, 4, 1],
              "kernel_divisor": 16, "amount": 0.5, "threshold": 1.5,
              "max_sharpen_delta": 8, "contrast": 1.04, "contrast_pivot": 128,
              "halo_pixels": 2, "new_spatial_detail": False}

CLARITY_PARAMETERS = {**PARAMETERS, "method": "multiscale-luminance-unsharp", "amount": 1.3,
                      "threshold": 0.6, "max_sharpen_delta": 24, "local_contrast_passes": 4,
                      "local_contrast_amount": 0.45, "local_contrast_limit": 10,
                      "combined_sharpen_limit": 28, "contrast": 1.07, "halo_pixels": 8,
                      "source_resampling": "lanczos"}


def smooth(values):
    """Separable, finite-support filter; the two-pixel halo prevents block seams."""
    weights = np.array(PARAMETERS["kernel"], dtype=np.float32) / 16
    padded = np.pad(values, ((0, 0), (2, 2)), mode="edge")
    horizontal = sum(weight * padded[:, i:i + values.shape[1]] for i, weight in enumerate(weights))
    padded = np.pad(horizontal, ((2, 2), (0, 0)), mode="edge")
    return sum(weight * padded[i:i + values.shape[0], :] for i, weight in enumerate(weights))


def enhance(rgba, profile="mild"):
    """Adjust luminance only, retaining alpha and limiting ringing/clipping."""
    rgb = rgba[:3].astype(np.float32)
    alpha = rgba[3].astype(np.float32) / 255
    luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    parameters = CLARITY_PARAMETERS if profile == "clarity" else PARAMETERS
    weight = smooth(alpha)
    blurred = np.divide(smooth(luminance * alpha), weight,
                        out=luminance.copy(), where=weight > 0)
    detail = luminance - blurred
    detail = np.sign(detail) * np.maximum(np.abs(detail) - parameters["threshold"], 0)
    sharpen = np.clip(detail * parameters["amount"], -parameters["max_sharpen_delta"], parameters["max_sharpen_delta"])
    if profile == "clarity":
        broad, broad_weight = luminance * alpha, alpha.copy()
        for _ in range(parameters["local_contrast_passes"]):
            broad, broad_weight = smooth(broad), smooth(broad_weight)
        broad = np.divide(broad, broad_weight, out=luminance.copy(), where=broad_weight > 0)
        limit = parameters["local_contrast_limit"]
        sharpen += np.clip((luminance - broad) * parameters["local_contrast_amount"], -limit, limit)
        sharpen = np.clip(sharpen, -parameters["combined_sharpen_limit"], parameters["combined_sharpen_limit"])
    delta = sharpen + (luminance - 128) * (parameters["contrast"] - 1)
    # Apply one common offset to RGB; never create new saturated colour fringes.
    delta = np.clip(delta, -rgb.min(axis=0), 255 - rgb.max(axis=0))
    result = rgba.copy()
    result[:3] = np.rint(rgb + delta[None, :, :]).astype(np.uint8)
    result[:, alpha == 0] = rgba[:, alpha == 0]
    return result


def enhance_raster(source, destination, block_size=1024, profile="mild", alpha_reference=None):
    from osgeo import gdal, osr
    gdal.UseExceptions()
    if destination.exists():
        raise ValueError("Enhanced raster already exists; choose a fresh work directory")
    ds = gdal.Open(str(source), gdal.GA_ReadOnly)
    if ds.RasterCount != 4 or any(ds.GetRasterBand(i).DataType != gdal.GDT_Byte for i in range(1, 5)):
        raise ValueError("Expected the original four-band byte RGBA raster")
    if ds.GetRasterBand(4).GetColorInterpretation() != gdal.GCI_AlphaBand:
        raise ValueError("Input must have an explicit alpha band")
    expected = osr.SpatialReference()
    expected.ImportFromEPSG(3857)
    if not ds.GetSpatialRef().IsSame(expected):
        raise ValueError("Input must be the original EPSG:3857 raster")
    reference = gdal.Open(str(alpha_reference)) if alpha_reference else None
    if reference and (reference.RasterCount != 4 or reference.RasterXSize != ds.RasterXSize
                      or reference.RasterYSize != ds.RasterYSize or reference.GetGeoTransform() != ds.GetGeoTransform()
                      or not reference.GetSpatialRef().IsSame(ds.GetSpatialRef())):
        raise ValueError("Alpha reference must have exactly the same georeferencing and dimensions")
    halo = (CLARITY_PARAMETERS if profile == "clarity" else PARAMETERS)["halo_pixels"]
    driver = gdal.GetDriverByName("GTiff")
    out = driver.Create(str(destination), ds.RasterXSize, ds.RasterYSize, 4, gdal.GDT_Byte,
                        options=["TILED=YES", "COMPRESS=DEFLATE", "BIGTIFF=IF_SAFER"])
    out.SetGeoTransform(ds.GetGeoTransform())
    out.SetProjection(ds.GetProjection())
    for i in range(1, 5):
        out.GetRasterBand(i).SetColorInterpretation(ds.GetRasterBand(i).GetColorInterpretation())
    max_delta, total_delta, valid_count, edge_fallback_count = 0, 0, 0, 0
    for y in range(0, ds.RasterYSize, block_size):
        height = min(block_size, ds.RasterYSize - y)
        for x in range(0, ds.RasterXSize, block_size):
            width = min(block_size, ds.RasterXSize - x)
            left, top = max(0, x - halo), max(0, y - halo)
            right, bottom = min(ds.RasterXSize, x + width + halo), min(ds.RasterYSize, y + height + halo)
            raw = ds.ReadAsArray(left, top, right - left, bottom - top)
            region = (slice(None), slice(y - top, y - top + height), slice(x - left, x - left + width))
            if reference:
                original_rgba = reference.ReadAsArray(left, top, right - left, bottom - top)
                fallback = (raw[3] == 0) & (original_rgba[3] > 0)
                edge_fallback_count += int(fallback[region[1:]].sum())
                raw[:, fallback] = original_rgba[:, fallback]
                raw[3] = original_rgba[3]
                raw[:3, raw[3] == 0] = original_rgba[:3, raw[3] == 0]
            original = raw[region]
            enhanced = enhance(raw, profile)[region]
            valid = original[3] > 0
            delta = np.abs(enhanced[:3].astype(np.int16) - original[:3].astype(np.int16))[:, valid]
            if delta.size:
                max_delta = max(max_delta, int(delta.max()))
                total_delta += int(delta.sum())
            valid_count += int(valid.sum())
            out.WriteArray(enhanced, x, y)
        print(f"Enhanced {min(y + height, ds.RasterYSize)}/{ds.RasterYSize} rows", flush=True)
    out.FlushCache()
    out = None
    return {"max_channel_change": max_delta, "mean_channel_change": total_delta / max(1, valid_count * 3),
            "valid_pixels": valid_count, "width": ds.RasterXSize, "height": ds.RasterYSize,
            "geotransform": list(ds.GetGeoTransform()), "alpha": "unchanged",
            "resampling_edge_fallback_pixels": edge_fallback_count}


def select_clarity_encoding(lossless_tiles, work, budget):
    """Fit the upload limit, prioritizing native-zoom RGB detail and exact alpha."""
    from PIL import Image
    from webp_checked_encoder import WebpEncoder
    paths = sorted(lossless_tiles.rglob("*.webp"))
    if sum(path.stat().st_size for path in paths) <= budget:
        return lossless_tiles, {"lossless": True, "quality": None}
    encoder = WebpEncoder()
    for near in (60, 40, None):
        destination = work / (f"tiles-near{near}-q100" if near else "tiles-quality100")
        destination.mkdir()
        print(f"Preserving Z13 with near-lossless {near}; lower zooms quality 100" if near
              else "Encoding all zooms at quality 100 to meet package limit", flush=True)
        def convert(path):
            relative = path.relative_to(lossless_tiles)
            with Image.open(path) as image:
                rgba = np.array(image.convert("RGBA"))
            if near and int(relative.parts[0]) == 13:
                data, audit = encoder.encode_checked(rgba, near_lossless=near)
                audit["near_lossless_tile"] = True
            else:
                buffer = BytesIO()
                Image.fromarray(rgba).save(buffer, format="WEBP", quality=100, method=4, exact=True)
                data = buffer.getvalue()
                audit = encoder._check(data, rgba)
                audit.update(lossless_fallback=False, near_lossless_tile=False)
                if not audit["alpha_unchanged"]:
                    data, audit = encoder.encode_checked(rgba, near_lossless=100)
                    audit.update(lossless_fallback=True, near_lossless_tile=False)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            audit.update(path=relative.as_posix(), bytes=len(data))
            return audit
        audits = []
        with ThreadPoolExecutor(max_workers=4) as executor:
            for audit in executor.map(convert, paths):
                audits.append(audit)
                if len(audits) % 300 == 0:
                    print(f"Verified encoded tiles {len(audits)}/{len(paths)}", flush=True)
        total = sum(item["bytes"] for item in audits)
        builder.save_json(work / f"encoding-{near or 'q100'}-audit.json", audits)
        if total <= budget:
            encoding = {"lossless": False, "quality": 100, "native_zoom": 13,
                        "native_zoom_near_lossless": near, "libwebp_version": encoder.version,
                        "alpha": "decoded and verified unchanged for every tile",
                        "lossless_fallback_tiles": sum(item["lossless_fallback"] for item in audits),
                        "native_zoom_max_rgb_error": max((item["max_visible_rgb_error"] for item in audits
                                                          if item["near_lossless_tile"]), default=None),
                        "reason": "Preserve native-zoom detail within 512 MiB upload limit"}
            return destination, encoding
    raise ValueError("Even quality 100 tiles exceed the package budget; originals retained")


def package(base, source, work, output, profile="mild", source_work=None):
    from PIL import Image
    from osgeo import gdal
    gdal.UseExceptions()
    if work.exists() or output.exists() or output.with_suffix(".zip").exists():
        raise ValueError("Work directory and output must be new; originals are never overwritten")
    if base == output or base in output.parents or base == work or base in work.parents:
        raise ValueError("Work/output must be outside the original package")
    manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    imagery = manifest.get("imagery", {})
    if (manifest.get("bounds") != builder.BOUNDS or manifest.get("coordinateSystem") != "WGS84"
            or imagery.get("tileSize") != 512 or imagery.get("minZoom") != 0 or imagery.get("maxZoom") != 13
            or imagery.get("tiles") != "./imagery/{z}/{x}/{y}.webp"):
        raise ValueError("Expected the existing Dongying Sentinel-2 512px Z0-13 package")
    provenance = json.loads((base / "sources/sentinel2-provenance.json").read_text(encoding="utf-8"))
    if provenance.get("enhancement"):
        raise ValueError("Refusing to sharpen an already enhanced package")
    if profile == "clarity" and not source_work:
        raise ValueError("Clarity profile requires the original verified raw source work directory")
    raster = gdal.Open(str(source), gdal.GA_ReadOnly)
    transform = raster.GetGeoTransform()
    resolution = 2 * math.pi * 6378137 / (512 * 2 ** 13)
    west, south, east, north = builder.BOUNDS
    project_y = lambda latitude: 6378137 * math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2))
    expected_extent = [6378137 * math.radians(west), project_y(south),
                       6378137 * math.radians(east), project_y(north)]
    extent = [transform[0], transform[3] + raster.RasterYSize * transform[5],
              transform[0] + raster.RasterXSize * transform[1], transform[3]]
    if (transform[2] != 0 or transform[4] != 0 or abs(transform[1] - resolution) > 1e-8
            or abs(transform[5] + resolution) > 1e-8
            or any(abs(a - b) > resolution + 1e-6 for a, b in zip(extent, expected_extent))):
        raise ValueError("Input georeferencing does not match the original map extent and grid")
    raster = None
    declared = json.loads((base / "checksums.json").read_text(encoding="utf-8"))
    if declared.get("algorithm") != "SHA-256":
        raise ValueError("Original package needs SHA-256 checksums")
    seen = set()
    for item in declared["files"]:
        path = builder.package_path(base, item["path"])
        identity = str(path).casefold()
        if identity in seen or path.is_symlink() or not path.is_file():
            raise ValueError("Invalid or duplicated original file")
        seen.add(identity)
        if path.stat().st_size != item["bytes"] or builder.digest(path) != item["sha256"]:
            raise ValueError("Original package checksum mismatch")
    actual = {str(p.resolve()).casefold() for p in base.rglob("*") if p.is_file() and p != base / "checksums.json"}
    if actual != seen or any(p.is_symlink() for p in base.rglob("*")):
        raise ValueError("Original package contains unaudited files or links")
    work.mkdir(parents=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    original_source = source
    parameters = CLARITY_PARAMETERS if profile == "clarity" else PARAMETERS
    if profile == "clarity":
        print("Reprojecting verified original bands with Lanczos", flush=True)
        source = builder.make_rgba(work, builder.read_catalog(source_work), resampling="lanczos", source_work=source_work)
        rebuilt_provenance = json.loads((work / "provenance.json").read_text(encoding="utf-8"))
        if rebuilt_provenance["input_files"] != provenance["input_files"]:
            raise ValueError("Rebuilt imagery does not use the original audited source bands")
        provenance["processing"] = rebuilt_provenance["processing"]
    enhanced = work / f"{profile}-rgba.tif"
    stats = enhance_raster(source, enhanced, profile=profile,
                           alpha_reference=original_source if profile == "clarity" else None)
    if stats["valid_pixels"] != provenance["coverage"]["valid_pixels"]:
        raise ValueError("Original raster coverage does not match the source package")
    tiles = work / "tiles"
    tile_options = ["--webp-lossless"] if profile == "clarity" else ["--webp-quality=85"]
    def cut(destination, options):
        subprocess.run([sys.executable, "-m", "osgeo_utils.gdal2tiles", "--xyz", "--tilesize=512", "--zoom=0-13",
                        "--tiledriver=WEBP", *options, "--processes=4", "--resampling=average",
                        "--webviewer=none", str(enhanced), str(destination)], check=True)
    cut(tiles, tile_options)
    encoding = {"lossless": profile == "clarity", "quality": None if profile == "clarity" else 85}
    if profile == "clarity":
        tiles, encoding = select_clarity_encoding(tiles, work, builder.MAX_ZIP - 45 * 1024**2)
    expected_tiles = [Path(str(z), str(x), f"{y}.webp") for z in range(14) for x, y in builder.tile_indices(builder.BOUNDS, z)]
    for relative in expected_tiles:
        with Image.open(tiles / relative) as tile:
            if tile.format != "WEBP" or tile.size != (512, 512):
                raise ValueError(f"Invalid imagery tile: {relative}")
            tile.load()
    shutil.copytree(base, output, ignore=shutil.ignore_patterns("imagery", "checksums.json"))
    for relative in expected_tiles:
        destination = output / "imagery" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(tiles / relative, destination)
    original_version = manifest["dataVersion"]
    suffix = "clarity2" if profile == "clarity" else "mild1"
    manifest.update(name="东营2026年卫星底图·" + ("清晰增强" if profile == "clarity" else "轻度优化"),
                    dataVersion=original_version + "-" + suffix)
    builder.save_json(output / "manifest.json", manifest)
    provenance["enhancement"] = {**parameters, "source_rgba_sha256": builder.digest(source),
                                  "original_alpha_reference_sha256": builder.digest(original_source),
                                  "source_manifest_sha256": builder.digest(base / "manifest.json"),
                                  "source_version": original_version, "statistics": stats,
                                  "native_resolution_m": 10, "applied_before_tiling": True}
    provenance["tiles"].update(encoding)
    builder.save_json(output / "sources/sentinel2-provenance.json", provenance)
    with (output / "SOURCES.txt").open("a", encoding="utf-8") as handle:
        handle.write("\n显示增强参数：" + json.dumps(parameters, ensure_ascii=False) + "；透明度和坐标不变。\n"
                     "原始分辨率仍为10米，没有新增地物细节。原地图包保留用于回滚。\n")
    builder.checksums(output)
    zip_path = output.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(output).as_posix())
    if zip_path.stat().st_size > builder.MAX_ZIP:
        raise ValueError("ZIP exceeds 512 MiB; do not upload")
    report = {"zip": str(zip_path), "zip_bytes": zip_path.stat().st_size, "zip_sha256": builder.digest(zip_path),
              "tiles": len(expected_tiles), "encoding": encoding, "data_version": manifest["dataVersion"], "statistics": stats}
    builder.save_json(work / "report.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("base", "source-rgba", "work-dir", "out"):
        parser.add_argument("--" + option, required=True, type=Path)
    parser.add_argument("--profile", choices=("mild", "clarity"), default="mild")
    parser.add_argument("--source-work", type=Path)
    args = parser.parse_args()
    os.environ.setdefault("GDAL_DATA", str(Path(sys.prefix) / "Library/share/gdal"))
    os.environ.setdefault("PROJ_DATA", str(Path(sys.prefix) / "Library/share/proj"))
    package(args.base.resolve(), args.source_rgba.resolve(), args.work_dir.resolve(), args.out.resolve(),
            args.profile, args.source_work.resolve() if args.source_work else None)
