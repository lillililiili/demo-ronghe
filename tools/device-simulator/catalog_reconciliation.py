"""Reconcile the current simulator-owned catalog through the platform API."""
import hashlib
from urllib.parse import quote, urlencode

from platform_client import SIMULATOR_VENDOR, SIMULATOR_MODEL

REASON = '当前模拟场景设备台账同步：退役已退出场景的设备，保留历史记录'


def rows(platform):
    """Require complete, nonduplicated pagination before planning any writes."""
    found, seen, expected, page = [], set(), None, 1
    while True:
        data = platform.call('GET', '/devices?' + urlencode(
            dict(page=page, size=100, sort='device_no_asc')))
        items, total = data.get('items'), data.get('total')
        if not isinstance(items, list) or type(total) is not int or total < 0:
            raise ValueError('设备台账分页不完整，未执行清理')
        if expected is not None and total != expected:
            raise ValueError('设备台账在读取期间变化，请重新核对')
        expected = total
        for row in items:
            identity = row.get('device_id')
            if not identity or identity in seen:
                raise ValueError('设备台账分页重复或缺少身份，未执行清理')
            seen.add(identity)
            found.append(row)
        if len(found) == expected:
            return found
        if not items or len(found) > expected:
            raise ValueError('设备台账分页数量不符，未执行清理')
        page += 1


def owned(row, broker):
    return (row.get('source_mode') == 'replay' and row.get('simulated') is True
            and row.get('vendor') == SIMULATOR_VENDOR and row.get('model') == SIMULATOR_MODEL
            and all(row.get(k) == broker[k] for k in ('owner_org_id', 'district_id')))


def binding(platform, row, broker):
    path = '/devices/' + quote(row['device_id'], safe='')
    detail = platform.call('GET', path)
    latest = detail.get('device') or {}
    status = platform.call('GET', path + '/protocol-status').get('details') or {}
    protocol = detail.get('protocol_code')
    protocol_identity = (status.get('edge_id') == str(detail.get('external_device_id')) + '-edge'
                         if protocol == 'EO_EDGE_MQTT_20250826' else status.get('provider_code') == 'map-sim')
    valid = (owned(latest, broker)
             and protocol in ('LINGYUN_MQTT_V8_6', 'EO_EDGE_MQTT_20250826')
             and status.get('broker_id') == broker['broker_id']
             and protocol_identity
             and status.get('external_device_id') == detail.get('external_device_id')
             and detail.get('external_device_id') == latest.get('device_no'))
    return latest if valid else None


def plan(platform, broker, current):
    """Use newly verified platform IDs, never a manifest from another database."""
    if (not current or broker.get('source_mode') != 'replay'
            or any(not broker.get(k) for k in ('broker_id', 'owner_org_id', 'district_id'))):
        raise ValueError('当前设备或模拟连接范围不完整，未执行清理')
    all_rows = {r['device_id']: r for r in rows(platform)}
    keep, retire = [], []
    for member in current.values():
        row = all_rows.get(member.get('platform_id'))
        if (not row or row.get('device_no') != member.get('external_id')
                or row.get('enabled') is not True or not owned(row, broker)
                or binding(platform, row, broker) is None):
            raise ValueError('当前设备身份与已连接平台不一致，未执行清理')
        keep.append(row['device_id'])
    if len(keep) != len(set(keep)):
        raise ValueError('当前场景重复使用同一设备身份，未执行清理')
    for identity, row in all_rows.items():
        if identity not in keep and owned(row, broker):
            latest = binding(platform, row, broker)
            if latest is not None:
                if type(latest.get('version')) is not int:
                    raise ValueError('待清理设备缺少版本，未执行清理')
                retire.append(latest)
    return {'keep': keep, 'retire': retire}


def apply(platform, preview):
    """Keep platform authorization, version, active-work guards and audit intact.

    Every successful removal is a catalog tombstone, not a history deletion.
    A partial failure is raised; startup must not pretend reconciliation passed.
    """
    result = {'retired': []}
    for row in preview['retire']:
        identity, version = row['device_id'], row['version']
        path = '/devices/' + quote(identity, safe='')
        latest = platform.call('GET', path).get('device') or {}
        if any(latest.get(k) != row.get(k) for k in (
                'version', 'enabled', 'source_mode', 'simulated', 'device_no', 'owner_org_id', 'district_id')):
            raise ValueError('设备资料已变化，请重新核对后清理：' + identity)
        key = hashlib.sha256((identity + ':' + str(version)).encode()).hexdigest()[:24]
        if latest.get('enabled') is True:
            response = platform.call('PATCH', path + '/enabled',
                                     dict(enabled=False, version=version, reason=REASON), 'catalog-off-' + key)
            version = (response.get('device') or {}).get('version')
            if type(version) is not int:
                raise ValueError('停用后未取得设备版本：' + identity)
        platform.call('DELETE', path, dict(version=version, reason=REASON), 'catalog-delete-' + key)
        result['retired'].append(identity)
    return result
