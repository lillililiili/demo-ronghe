"""Read the saved facts before observation publishing; never repairs business data."""
from engine import coordinates


def route_version_mismatch(version, plan):
    """Return the first field where a saved route version differs from the scene task's corridor, or None."""
    for field, expected in [('corridor_width_m',plan['width']), ('min_altitude_m',plan['min']),
                            ('max_altitude_m',plan['max']), ('altitude_datum',plan.get('altitudeDatum','AMSL'))]:
        if version.get(field) != expected:
            return field
    points = (version.get('centerline') or {}).get('coordinates', [])
    expected_points = [coordinates(point) for point in plan['points']]
    if len(points)!=len(expected_points) or any(len(a)<2 or abs(a[0]-b[0])>1e-7 or abs(a[1]-b[1])>1e-7 for a,b in zip(points,expected_points)):
        return 'centerline'
    return None


def verify(platform, scene, manifest, scope):
    result = {'plans': [], 'routes': [], 'devices': []}
    for pid, expected in manifest.get('plan_expectations', {}).items():
        actual = platform.call('GET', '/flight-plans/' + pid)
        for key in ('uav_sn', 'start_at', 'end_at', 'source_mode'):
            if actual.get(key) != expected[key]:
                raise ValueError('任务回读不一致：' + pid + ' / ' + key)
        for key, value in scope.items():
            if actual.get(key) != value:
                raise ValueError('任务回读范围不一致：' + pid)
        if (actual.get('route') or {}).get('route_version_id') != expected['route_version_id']:
            raise ValueError('任务回读航线版本不一致：' + pid)
        result['plans'].append({'plan_id':pid,'uav_sn':actual.get('uav_sn'),
                                'start_at':actual['start_at'],'end_at':actual['end_at'],
                                'route_version_id':expected['route_version_id']})
    for plan in scene['plans']:
        binding = manifest['plans'][plan['id']]
        route = binding
        while isinstance(route, dict) and 'route_version_id' not in route and isinstance(route.get('result'), dict):
            route = route['result']
        version_id = route.get('route_version_id')
        if not version_id:
            raise ValueError('航线回读缺少版本编号：'+plan['id'])
        version = platform.call('GET', '/route-versions/' + version_id)
        mismatch = route_version_mismatch(version, plan)
        if mismatch == 'centerline':
            raise ValueError('航线回读坐标不一致：'+plan['id'])
        if mismatch:
            raise ValueError('航线回读不一致：'+plan['id']+' / '+mismatch)
        for pid in binding['ids']:
            expected = manifest['plan_expectations'][pid]
            if version['valid_from']>expected['start_at'] or (version.get('valid_to') is not None and version['valid_to']<expected['end_at']):
                raise ValueError('航线有效期未覆盖模拟任务：'+pid)
        result['routes'].append({'route_version_id':version_id,'altitude_datum':version['altitude_datum']})
    for entry in manifest['devices'].values():
        if entry['kind']=='normalized': continue
        status=platform.call('GET','/devices/'+entry['platform_id']+'/protocol-status')
        actual=status.get('details') or {}
        for key, expected in [('broker_id',manifest['broker_id']),('provider_code',manifest['provider']),
                              ('external_device_id',entry['external_id']),('device_type_abbr',entry['kind'])]:
            # Protocol C has edge identity instead of a protocol-A provider.
            if entry['kind']=='eo' and key in ('provider_code','device_type_abbr'): continue
            if actual.get(key)!=expected:
                raise ValueError('设备回读绑定不一致：'+entry['external_id']+' / '+key)
        result['devices'].append({'device_id':entry['platform_id'],'external_device_id':entry['external_id']})
    return result
