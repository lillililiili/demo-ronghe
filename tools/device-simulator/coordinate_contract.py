"""Coordinate declarations for this simulator's documented WGS-84 scene format.

This is not a conversion or a general external-data normalizer. Explicit other
datums or malformed declarations are rejected instead of being overwritten.
"""

def simulator_wgs84(*scopes):
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        for key in ('coordinate_system', 'coordinateSystem'):
            if key in scope:
                value = scope[key]
                if not isinstance(value, str) or value.strip().upper() not in ('WGS84', 'WGS-84'):
                    raise ValueError('模拟器坐标必须明确为 WGS-84；其他坐标系须先由提供方转换')
    return 'WGS84'
