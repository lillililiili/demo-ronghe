"""Reconcile the current simulator-owned catalog through the platform API."""
import hashlib
from urllib.parse import quote, urlencode

from platform_client import SIMULATOR_VENDOR, SIMULATOR_MODEL, PlatformError

REASON = '当前模拟场景设备台账同步：退役已退出场景的设备，保留历史记录'
BUSY_REASON = '当前模拟场景设备台账同步：设备正忙，这次不退役，重新启用'


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


def label(row):
    """Device number plus name, the way people find it in 设备管理."""
    name = row.get('name')
    return str(row.get('device_no') or row.get('device_id')) + ('（' + name + '）' if name else '')


def blockers(platform, path):
    """What still keeps a device busy, or None when the platform cannot say (older version)."""
    try:
        data = platform.call('GET', path + '/catalog-blockers')
    except PlatformError as error:
        if error.status in (404, 405) and error.code != 'DEVICE_NOT_FOUND':
            return None
        raise
    reasons = data.get('reasons') if isinstance(data, dict) else None
    if not isinstance(reasons, list) or not all(isinstance(r, str) and r for r in reasons):
        raise ValueError('设备占用情况读取不完整，未执行清理')
    return reasons


def skipped(row, reasons):
    return dict(device_id=row['device_id'], device_no=row.get('device_no'), name=row.get('name'),
                reasons=list(reasons))


def apply(platform, preview):
    """Keep platform authorization, version, active-work guards and audit intact.

    Every successful removal is a catalog tombstone, not a history deletion.
    A device that is still busy (an unfinished command, EO task, countermeasure or
    emergency-stop check) is left alone, still switched on, and reported in
    ``skipped`` with the platform's reasons; the start goes on. Any other failure
    is raised with the device number: startup must not pretend reconciliation passed.
    """
    result = {'retired': [], 'retired_devices': [], 'skipped': []}
    for row in preview['retire']:
        identity, version = row['device_id'], row['version']
        path = '/devices/' + quote(identity, safe='')
        who = label(row)
        latest = platform.call('GET', path).get('device') or {}
        if any(latest.get(k) != row.get(k) for k in (
                'version', 'enabled', 'source_mode', 'simulated', 'device_no', 'owner_org_id', 'district_id')):
            raise ValueError('设备资料已变化，请重新核对后清理：' + who)
        busy = blockers(platform, path)
        if busy:
            result['skipped'].append(skipped(row, busy))
            continue
        key = hashlib.sha256((identity + ':' + str(version)).encode()).hexdigest()[:24]
        switched_off = False
        if latest.get('enabled') is True:
            response = platform.call('PATCH', path + '/enabled',
                                     dict(enabled=False, version=version, reason=REASON), 'catalog-off-' + key)
            version = (response.get('device') or {}).get('version')
            if type(version) is not int:
                raise ValueError('停用后未取得设备版本：' + who)
            switched_off = True
        try:
            platform.call('DELETE', path, dict(version=version, reason=REASON), 'catalog-delete-' + key)
        except PlatformError as error:
            if error.code != 'DEVICE_BUSY':
                raise ValueError('设备 ' + who + ' 没能从台账退役：' + (error.detail or str(error))
                                 + ('（它已被停用，请在设备管理里核对）' if switched_off else '')) from None
            # It became busy after the check: put it back the way it was and leave it alone.
            if switched_off:
                try:
                    platform.call('PATCH', path + '/enabled',
                                  dict(enabled=True, version=version, reason=BUSY_REASON), 'catalog-on-' + key)
                except ValueError as again:
                    raise ValueError('设备 ' + who + ' 正忙，这次不退役，但已停用后没能重新启用：' + str(again)
                                     + '。请在设备管理里把它启用') from None
            try:
                reasons = blockers(platform, path)
            except ValueError:
                reasons = None
            result['skipped'].append(skipped(row, reasons or [error.detail or '设备还有没结束的工作']))
            continue
        result['retired'].append(identity)
        result['retired_devices'].append(dict(device_id=identity, device_no=row.get('device_no'), name=row.get('name')))
    return result
