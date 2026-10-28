"""开始模拟之前的检查：只读场景和收发设置，不向平台发送任何东西。

“挡住”的问题（平台一定会拒绝）直接不让开始，什么都不发出去；“提醒”的问题交给人自己决定。
页面在点“开始模拟”时先问这里，服务端开始时再用同一套规则挡一次，两边不会各说各的。
"""
import datetime as dt

from engine import LABELS
from fullchain import SHANGHAI, plan_window

# 平台后台已停用、不能登记的设备类型：AOA、协议破解、Remote ID、诱骗、干扰、驱鸟炮。
RETIRED_KINDS = ('aoa', 'dcd', 'rid', 'dec', 'ifr', 'bsc')
# 放置设备组、新建设备时还能选的类型，供页面和测试对照。
CURRENT_KINDS = ('weather', '5ga', 'eo', 'tdoa', 'radar', 'countermeasure')


def _dicts(value):
    """场景里的列表项；格式不对的项直接跳过，交给后面的编译去报“哪一项不对”。"""
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _scene(scene):
    return scene if isinstance(scene, dict) else {}


def retired_devices(scene):
    """场景里会被登记到平台、但类型已停用的设备。"""
    result = []
    for site in _dicts(_scene(scene).get('sites')):
        for device in _dicts(site.get('devices')):
            if device.get('kind') in RETIRED_KINDS and device.get('send') is not False:
                result.append({'site': site.get('name') or site.get('id') or '', 'device': device.get('name') or device.get('id') or '',
                               'kind': device['kind'], 'kind_label': LABELS.get(device['kind'], device['kind']),
                               'site_id': site.get('id'), 'device_id': device.get('id')})
    return result


def retired_message(items):
    names = '、'.join(f'“{item["device"]}”（{item["site"]}，类型 {item["kind_label"]}）' for item in items)
    return ('这些设备的类型平台已经停用，不能登记，所以这次什么都没有发出去：' + names +
            '。请先把它们从场景里去掉（点“开始模拟”时弹出的提示框里有“从草稿里删掉”按钮），'
            '或换成雷达、TDOA、5G-A、光电的设备，再点“开始模拟”。')


def normal_mode_ignored(scene, config):
    """正常模式下，开始时这几类设置会被改回正常（与 realtime_control.prepare_scene 一致）。
    全量关联场景不改写，所以不提示。"""
    scene = _scene(scene)
    fullchain = scene.get('fullchain')
    if (config or {}).get('mode') != 'normal' or isinstance(fullchain, dict) and fullchain.get('enabled'):
        return []
    items = []
    for site in _dicts(scene.get('sites')):
        for device in _dicts(site.get('devices')):
            where = f'设备“{device.get("name") or device.get("id")}”（{site.get("name") or site.get("id")}）'
            if device.get('health') == '故障':
                items.append(where + '的工作状态设成了“故障”')
            if device.get('heartbeat') == '停止心跳':
                items.append(where + ('设成了“断开”' if device.get('kind') == 'adsb' else '的心跳设成了“停止心跳”'))
    for risk in _dicts(scene.get('risks')):
        if risk.get('type') in ('offline', 'fault') and risk.get('enabled'):
            items.append(f'平台判定条件“{risk.get("name") or ("设备离线" if risk["type"] == "offline" else "设备故障")}”已经勾选')
    for target in _dicts(scene.get('targets')):
        if target.get('notificationBehavior') == 'drop_sms':
            items.append(f'目标“{target.get("name") or target.get("id")}”设成了“短信送达后停止目标上报”')
    return items


def _day(moment, today):
    delta = (moment.date() - today).days
    return {0: '今天', 1: '明天', -1: '昨天'}.get(delta, f'{moment.month}月{moment.day}日')


def window_text(start_ms, end_ms, now_ms):
    """任务时段的说法：“今天 09:00–09:30（北京时间）”；跨夜写成“今天 22:00 到 明天 02:00（北京时间）”。"""
    today = dt.datetime.fromtimestamp(now_ms / 1000, SHANGHAI).date()
    start = dt.datetime.fromtimestamp(start_ms / 1000, SHANGHAI)
    end = dt.datetime.fromtimestamp(end_ms / 1000, SHANGHAI)
    if start.date() == end.date():
        return f'{_day(start, today)} {start:%H:%M}–{end:%H:%M}（北京时间）'
    return f'{_day(start, today)} {start:%H:%M} 到 {_day(end, today)} {end:%H:%M}（北京时间）'


def plans_in_use(scene):
    """有无人机、鸟群等挂着、或有勾选的判定条件在用的飞行任务编号；故意设成“超出任务时段”的目标不算。"""
    scene = _scene(scene)
    risks = [r for r in _dicts(scene.get('risks')) if r.get('enabled')]
    deliberately_late = {(r.get('targetId'), r.get('planId')) for r in risks if r.get('type') == 'time'}
    used = {t['planId'] for t in _dicts(scene.get('targets'))
            if t.get('planId') and (t.get('id'), t['planId']) not in deliberately_late}
    used.update(r['planId'] for r in risks if r.get('type') != 'time' and r.get('planId'))
    return used


def plan_window_notes(scene, now_ms):
    """正在用的飞行任务里，今天的时段不包含现在的：平台会把挂在它下面的无人机判成超出时段。"""
    scene = _scene(scene)
    used = plans_in_use(scene)
    notes = []
    for plan in _dicts(scene.get('plans')):
        if plan.get('id') not in used or plan.get('timeMode') == 'past':
            continue
        try:
            start, end = plan_window(plan, now_ms)
        except (ValueError, KeyError, TypeError):
            continue
        if start <= now_ms < end:
            continue
        notes.append({'plan_id': plan['id'], 'plan': plan.get('name') or plan['id'], 'window': window_text(start, end, now_ms)})
    return notes


def check(scene, config, now_ms, can_switch_mode=True):
    """页面点“开始模拟”时的检查结果：blocking 挡住不让开始，notices 只提醒、由人决定。"""
    blocking, notices = [], []
    retired = retired_devices(scene)
    if retired:
        blocking.append({'code': 'RETIRED_DEVICE', 'title': '有设备的类型已经停用，不能开始',
                         'message': '下面这些设备的类型平台已经停用，不能登记，所以现在不能开始。',
                         'items': [f'“{item["device"]}”（{item["site"]}，类型 {item["kind_label"]}）' for item in retired],
                         'devices': [{'site_id': item['site_id'], 'device_id': item['device_id']} for item in retired]})
    ignored = normal_mode_ignored(scene, config)
    if ignored:
        message = '正常模式开始时会把故障、离线、短信送达后停报这几类设置改回正常。想让它们生效，把收发模式改成“异常”再开始。'
        if not can_switch_mode:
            message = ('正常模式开始时会把故障、离线、短信送达后停报这几类设置改回正常。想让它们生效，要把收发模式改成“异常”；'
                       '现在收发端还开着，要先点页面里“实时收发”一栏的“停止全部收发”，才能改模式，改完再点“开始模拟”。')
        notices.append({'code': 'NORMAL_MODE_IGNORES', 'title': '现在是“正常”模式，下面这些设置不会生效',
                        'message': message, 'can_fix': bool(can_switch_mode), 'items': ignored})
    windows = plan_window_notes(scene, now_ms)
    if windows:
        time_text = dt.datetime.fromtimestamp(now_ms / 1000, SHANGHAI).strftime('%H:%M')
        notices.append({'code': 'PLAN_OUTSIDE_WINDOW', 'title': f'现在是北京时间 {time_text}，有飞行任务的时段不包含现在',
                        'message': '挂在这些任务下的无人机会被平台判成“超出任务时段”，鸟群、气球靠近航线的风险也可能不出现。',
                        'items': [f'“{note["plan"]}”：{note["window"]}' for note in windows],
                        'plans': [note['plan_id'] for note in windows]})
    return {'blocking': blocking, 'notices': notices, 'checked_at': now_ms}
