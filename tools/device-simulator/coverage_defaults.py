"""Explicit simulator capability defaults; never inferred for real devices."""
from copy import deepcopy

DEFAULT_RANGES = {
    'radar': {'kind': 'circle', 'radiusM': 3000},
    'tdoa': {'kind': 'circle', 'radiusM': 2000},
    '5ga': {'kind': 'circle', 'radiusM': 2500},
    'eo': {'kind': 'sector', 'rangeM': 1500, 'azimuthDeg': 0, 'fovDeg': 120},
    'countermeasure': {'kind': 'circle', 'radiusM': 1000},
    'weather': {'kind': 'circle', 'radiusM': 1000},
}

def default_coverage(kind):
    value = DEFAULT_RANGES.get(kind)
    return dict(deepcopy(value), sourceLabel='模拟器设备范围（模拟参数）') if value else None
