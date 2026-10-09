"""Mock airport for acceptance item 4-3 (2026-10-08, 新-27).

One airport whose name says 模拟, one approach route and one protected target, entered through the
platform's own airport API with the logged-in account. They sit in the empty strip below the demo
scenes on the simulator map, so a balloon can be put 300 m from the approach route (inside the
500 m buffer of rule C05) or 1 km away (outside it), far from every demo task route.

Airport data in the platform is append-only: it cannot be edited, deleted or disabled. Entering it
twice therefore never creates a second airport; a later call only adds a part that is missing.
"""
import math
import urllib.parse
import uuid

from engine import coordinates

ICAO = 'ZZMOCK'
NAME = '模拟机场（验收 4-3 用）'
NOTE = '设备模拟器录入的模拟资料，只用于验收 4-3；不录进正式上线的系统。'
APPROACH_NAME = '模拟进近航线'
PROTECTED_NAME = '模拟机场塔台'
PROTECT_WIDTH_M = 1000
PROTECTED_RADIUS_M = 100
ELEVATION_M = 4

# Simulator map grid (see engine.coordinates): x grows east, y grows south.
APPROACH = [[380, 630], [650, 630]]
REFERENCE = [662, 630]
PROTECTED = [690, 642]
TEST_DISTANCES_M = (300, 1000)
METRES_PER_DEGREE = 111320


def layout():
    """Geometry the simulator enters and draws, in WGS84 and in map-grid coordinates."""
    approach = [coordinates(p) for p in APPROACH]
    mid_lon = (approach[0][0] + approach[1][0]) / 2
    mid_lat = (approach[0][1] + approach[1][1]) / 2
    points = []
    for metres in TEST_DISTANCES_M:
        # Due north of the middle of the (east-west) approach route.
        lat = mid_lat + metres / METRES_PER_DEGREE
        points.append({'distance_m': metres, 'longitude': round(mid_lon, 6), 'latitude': round(lat, 6),
                       'grid': [round((mid_lon - 118.56) / .00012, 1), round((37.50 - lat) / .00012, 1)]})
    return {'icao_code': ICAO, 'name': NAME, 'approach_name': APPROACH_NAME, 'protected_name': PROTECTED_NAME,
            'approach': approach, 'approach_grid': APPROACH,
            'reference': coordinates(REFERENCE), 'reference_grid': REFERENCE,
            'protected': coordinates(PROTECTED), 'protected_grid': PROTECTED,
            'buffer_m': 500, 'protected_pad_m': 200, 'test_points': points,
            'grid_metres_per_unit': [METRES_PER_DEGREE * .00012 * math.cos(math.radians(mid_lat)),
                                     METRES_PER_DEGREE * .00012]}


def find(platform):
    """Return the mock airport row, or None. Airports are listed by ICAO code, so read every page."""
    page = 1
    while page <= 50:
        data = platform.call('GET', '/airports?' + urllib.parse.urlencode({'page': page, 'size': 100}))
        items = data.get('items') or []
        for item in items:
            if item.get('icao_code') == ICAO:
                return item
        if len(items) < 100:
            return None
        page += 1
    return None


def status(platform):
    """What the platform holds now. Entering nothing: this is what the map draws on start."""
    airport = find(platform)
    if airport is None:
        return {'exists': False, 'complete': False, **layout(),
                'message': '系统里还没有模拟机场资料'}
    detail = platform.call('GET', '/airports/' + urllib.parse.quote(airport['airport_id'], safe=''))
    has_route = any(r.get('name') == APPROACH_NAME for r in detail.get('procedure_routes') or [])
    has_target = any(t.get('name') == PROTECTED_NAME for t in detail.get('protected_targets') or [])
    return {'exists': True, 'complete': has_route and has_target, 'airport_id': airport['airport_id'],
            'owner_org_id': airport.get('owner_org_id'), 'district_id': airport.get('district_id'),
            'owner_org_name': airport.get('owner_org_name'), 'district_name': airport.get('district_name'),
            **layout(),
            'message': '模拟机场资料已在系统里' if has_route and has_target else '模拟机场资料不完整，请再点一次“录入模拟机场资料”补齐'}


def ensure(platform, scope):
    """Enter the mock airport in the simulator connection's unit and district; add only what is missing."""
    org, district = scope.get('owner_org_id'), scope.get('district_id')
    if not org or not district:
        raise ValueError(scope.get('message') or '没找到模拟器连接的单位和区域，请先登录并启动一次模拟收发')
    shape = layout()
    airport = find(platform)
    created = airport is None
    if created:
        lon, lat = shape['reference']
        airport = platform.call('POST', '/airports', {
            'icao_code': ICAO, 'name': NAME, 'longitude': round(lon, 6), 'latitude': round(lat, 6),
            'elevation_amsl_m': ELEVATION_M, 'owner_org_id': org, 'district_id': district, 'note': NOTE}, key())
    elif (airport.get('owner_org_id'), airport.get('district_id')) != (org, district):
        raise ValueError('系统里已有模拟机场，但它的单位或区域和模拟器连接不一致；机场资料录进去以后不能改，'
                         '只有同一单位和区域的气球才会被判。请用原来的单位和区域，或联系开发处理')
    detail = platform.call('GET', '/airports/' + urllib.parse.quote(airport['airport_id'], safe=''))
    added = []
    if not any(r.get('name') == APPROACH_NAME for r in detail.get('procedure_routes') or []):
        line = ','.join(f'{round(lon, 6)} {round(lat, 6)}' for lon, lat in shape['approach'])
        platform.call('POST', '/airports/' + urllib.parse.quote(airport['airport_id'], safe='') + '/procedure-routes', {
            'kind': 'APPROACH', 'name': APPROACH_NAME, 'centerline': f'SRID=4326;LINESTRING({line})',
            'protect_width_m': PROTECT_WIDTH_M}, key())
        added.append('进近航线')
    if not any(t.get('name') == PROTECTED_NAME for t in detail.get('protected_targets') or []):
        lon, lat = shape['protected']
        platform.call('POST', '/airports/' + urllib.parse.quote(airport['airport_id'], safe='') + '/protected-targets', {
            'name': PROTECTED_NAME, 'kind': 'TOWER', 'longitude': round(lon, 6), 'latitude': round(lat, 6),
            'radius_m': PROTECTED_RADIUS_M}, key())
        added.append('保护目标')
    result = status(platform)
    if not result['complete']:
        raise ValueError('模拟机场资料没有录全，请再试一次')
    if created:
        result['message'] = '已录入模拟机场、进近航线和保护目标'
    elif added:
        result['message'] = '已补录' + '、'.join(added)
    else:
        result['message'] = '模拟机场资料已在系统里，没有重复录入'
    return result


def key():
    return 'mock-airport-' + uuid.uuid4().hex[:24]
