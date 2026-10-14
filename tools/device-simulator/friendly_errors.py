"""把技术报错翻成“哪个对象出了什么问题、怎么办”；原来的技术文字不丢，留作“技术详情”。

只改说法，不改什么时候报错。认不出来的报错原样放行（本来就是写给人看的中文），不乱猜。
"""
import re

# 平台接口路径 → 人能看懂的对象名；长的前缀写在前面。
OBJECTS = (
    ('/local-interface-simulator/plans', '飞行任务'),
    ('/local-interface-simulator/airspaces', '空域'),
    ('/local-interface-simulator/weather-risks', '天气风险'),
    ('/local-interface-simulator/weather', '天气预报'),
    ('/local-interface-simulator/countermeasure-device', '模拟反制设备'),
    ('/local-interface-simulator/radar-device', 'TCP 雷达设备'),
    ('/local-interface-simulator/video-streams', '光电视频'),
    ('/local-interface-simulator/target-observations', '目标观测'),
    ('/local-interface-simulator/observation-devices', '观测来源设备'),
    ('/local-interface-simulator/routes', '任务航线'),
    ('/local-interface-simulator/bindings', '通知接收端'),
    ('/local-interface-simulator/receiver-context', '通知接收端'),
    ('/local-interface-simulator/messages', '通知回执'),
    ('/local-interface-simulator/punishment-recipients', '处罚接收单位'),
    ('/local-interface-simulator/session', '登录状态'),
    ('/local-interface-simulator/', '模拟器配套接口'),
    ('/devices/onboard', '设备登记'),
    ('/devices', '设备'),
    ('/flight-plans', '飞行任务'),
    ('/route-versions', '任务航线'),
    ('/routes', '任务航线'),
    ('/airspaces', '空域'),
    ('/mqtt-brokers', '设备数据连接'),
    ('/targets', '目标'),
    ('/tracks', '航迹'),
    ('/alarms', '告警'),
    ('/legality-evaluations', '合法性研判'),
    ('/airports', '模拟机场'),
    ('/automation-rule-groups', '自动规则'),
    ('/auth', '登录'),
)

# 场景或提交内容里的字段名 → 人话。
FIELDS = {
    'name': '名称', 'id': '编号', 'kind': '类型', 'max': '高度上限', 'min': '最低高度', 'width': '走廊宽度',
    'points': '坐标点', 'path': '轨迹', 'start': '开始时间', 'end': '结束时间', 'x': '位置', 'y': '位置',
    'devices': '设备', 'sites': '设备组', 'targets': '目标', 'plans': '飞行任务', 'zones': '区域', 'risks': '平台判定条件',
    'duration': '运行时长', 'health': '工作状态', 'heartbeat': '心跳模式', 'interval': '心跳间隔', 'speed': '水平速度',
    'height': '基准高度', 'action': '操作', 'uav_sn': '无人机序列号', 'start_at': '开始时间', 'end_at': '结束时间',
    'source_mode': '数据来源', 'route_version_id': '航线版本', 'broker_id': '设备数据连接', 'provider_code': '接入方',
    'external_device_id': '设备编号', 'device_type_abbr': '设备类型',
}


def subject_of(path):
    """接口路径对应的对象名；路径可能带查询参数。"""
    path = (path or '').split('?', 1)[0]
    for prefix, name in OBJECTS:
        if path.startswith(prefix):
            return name
    return '平台接口'


def field_name(key):
    return FIELDS.get(str(key), str(key))


def _http(match):
    path, code, text = match.group('path'), int(match.group('code')), match.group('msg').strip()
    subject = subject_of(path)
    tail = f'（平台说：{text}）' if text else ''
    if code == 400 and '设备类型已停用' in text:
        return (f'{subject}失败：平台已经停用这类设备，不能登记。'
                '请把它从场景里去掉（点“开始模拟”时的检查提示框里有“从草稿里删掉”按钮），'
                '或换成雷达、TDOA、5G-A、光电的设备，再开始。')
    if code == 401:
        return '登录已经失效，请重新登录系统后再试。'
    if code == 403:
        return f'{subject}被拒绝：当前登录的账号没有这项权限{tail}。请换一个有权限的账号（比如管理员）登录后再试。'
    if code == 404:
        return f'平台里找不到{subject}{tail}。请确认登录的是正确的系统，或停止后重新开始一次模拟。'
    if code == 409:
        return (f'{subject}和平台里已有的记录冲突{tail}。多半是上一轮模拟留下的内容还在：'
                '先点“停止”，等一分钟再开始；还是不行，请把“技术详情”发给开发人员。')
    if code == 429:
        return f'平台暂时拒绝了{subject}的请求，说明提交得太频繁{tail}。请等十几秒再试。'
    if code in (400, 422):
        return f'{subject}平台没有接受{tail}。请检查这一项的内容后再试。'
    if code >= 500:
        return (f'平台处理{subject}时出错了（错误码 {code}）{tail}。请稍等再试；'
                '一直这样，请把“技术详情”发给开发人员。')
    return f'平台对{subject}返回了错误码 {code}{tail}。'


RULES = (
    (re.compile(r'^系统接口 (?P<path>\S+) 返回 (?P<code>\d{3})：(?P<msg>.*)$', re.S), _http),
    (re.compile(r'^系统接口 (?P<path>\S+) (?:连接失败|连接中断)'),
     lambda m: f'连不上平台后台，所以“{subject_of(m.group("path"))}”这一步没有完成。请确认后台服务在运行（默认 8081 端口），再重试。'),
    (re.compile(r'^系统接口 (?P<path>\S+) 请求超时'),
     lambda m: f'平台后台响应太慢，“{subject_of(m.group("path"))}”这一步没有完成。请稍等再试；一直这样，请检查后台是不是卡住了。'),
    (re.compile(r'^系统接口 (?P<path>\S+) 返回无效 JSON'),
     lambda m: f'平台后台返回的内容不对，“{subject_of(m.group("path"))}”这一步没有完成。请检查后台服务状态；一直这样，请把“技术详情”发给开发人员。'),
    (re.compile(r'^系统接口未成功：(?P<path>\S+)'),
     lambda m: f'平台没有接受{subject_of(m.group("path"))}。请重试一次；还是不行，请把“技术详情”发给开发人员。'),
    (re.compile(r'^任务回读不一致：(?P<id>\S+) / (?P<field>\w+)$'),
     lambda m: (f'飞行任务提交后核对不上：平台里的“{field_name(m.group("field"))}”和刚提交的不一样（任务 {m.group("id")}）。'
                '多半是平台上还留着同名的旧任务：先点“停止”，等一分钟再开始；再不行，请把“技术详情”发给开发人员。')),
    (re.compile(r'^任务回读范围不一致：(?P<id>\S+)$'),
     lambda m: f'飞行任务提交后核对不上：平台里记的单位或区县和模拟器连接的不一样（任务 {m.group("id")}）。请重新登录后再开始；再不行，请把“技术详情”发给开发人员。'),
    (re.compile(r'^航线回读(?:不一致|坐标不一致|缺少版本编号)：(?P<id>\S+)(?: / (?P<field>\w+))?$'),
     lambda m: (f'任务航线提交后核对不上（航线 {m.group("id")}'
                + (f'，“{field_name(m.group("field"))}”不一致' if m.group('field') else '')
                + '）。多半是平台上留着同名的旧航线：先点“停止”，等一分钟再开始；再不行，请把“技术详情”发给开发人员。')),
    (re.compile(r'^设备回读绑定不一致：(?P<device>\S+) / (?P<field>\w+)$'),
     lambda m: (f'模拟设备登记后核对不上：平台里这台设备（{m.group("device")}）的“{field_name(m.group("field"))}”和模拟器登记的不一样。'
                '请先点“停止”，到平台“设备管理”里确认这台设备有没有被改过；再不行，请把“技术详情”发给开发人员。')),
    (re.compile(r'^后台 MQTT 订阅等待超时，未开始发送'),
     lambda m: ('平台后台 30 秒内没有确认收到这批模拟设备的连接，所以没有开始发送。'
                '请确认平台后台在正常运行、本机 MQTT 服务可用，再点“开始模拟”重试；一直这样，请把“技术详情”发给开发人员。')),
    (re.compile(r'^后台 MQTT 设备绑定不一致，未开始发送：(?P<device>\S+)'),
     lambda m: f'模拟设备（{m.group("device")}）在平台里绑到的连接和模拟器用的不一样，所以没有开始发送。请先点“停止”再重新开始；再不行，请把“技术详情”发给开发人员。'),
    (re.compile(r'^MQTT 连接或认证失败$'),
     lambda m: '连不上设备数据的 MQTT 服务，或者账号密码不对，所以没有开始发送。请确认本机 MQTT 服务在运行，再重试。'),
)


def explain(text):
    """技术报错 → (给人看的说法, 技术详情)；认不出来就原样放行，技术详情为空。"""
    text = str(text or '')
    for pattern, build in RULES:
        match = pattern.match(text)
        if match:
            return build(match), text
    return text, ''


def explain_exception(error):
    """异常 → (给人看的说法, 技术详情)。缺字段、格式不对这类 Python 自带的报错没法直接给人看，在这里翻译。"""
    if isinstance(error, KeyError) and error.args:
        key = error.args[0]
        return (f'场景或提交的内容里缺少“{field_name(key)}”这一项，请检查后再试。', f'缺少字段 {key!r}')
    if isinstance(error, TypeError):
        return ('场景或提交的内容里有一项格式不对，请检查最近改过的那一项后再试。', f'TypeError: {error}')
    return explain(str(error))
