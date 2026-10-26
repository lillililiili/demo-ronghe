"""九个验收流程：只读现有流程文件，流程 9 提供转向和入区两种固定变式。

不再依赖外部脚本，也不改写任何文件。流程文件放在 scenarios/acceptance-flows-1-7-20261008/，
这里只读取、校验，再把每个流程的说明（演示什么、开始前、会看到什么、要做什么）一起交给页面。
"""
import json
from pathlib import Path
from state_file import read_saved_text as read_text

OUTPUT_NAME = 'acceptance-flows-1-7-20261008'
FLOW_FILES = {
    1: 'flow-1-auto-disposal.json',
    2: 'flow-2-after-sms-departure.json',
    3: 'flow-3-no-filing-direct-disposal.json',
    4: 'flow-4-operator-false-alarm.json',
    5: 'flow-5-manual-disposal.json',
    6: 'flow-6-weather-risk.json',
    7: 'flow-7-bird-flock.json',
    8: 'flow-8-device-maintenance.json',
    9: 'flow-9-prediction-warning.json',
}

# 变式只能来自这里的固定映射，不能由 manifest 或请求提供任意路径。
FLOW_VARIANTS = {
    9: {
        'avoid': {
            'file': 'flow-9-prediction-warning.json',
            'label': '5分钟转向撤销',
            'sees': ['约44秒，无人机在矩形左边界外转向左上方。连续新实测证明未来安全避开后，平台撤销预警并保留历史；转向期间预测可能暂不可判断。'],
            'todo': [
                '约44秒观察转向，随后到告警事件核对预警是否撤销、历史是否保留；实际结果以平台的新观测判断为准。',
                '保留收发到5分钟结束；如已人工启动反制，核对停止指令及模拟设备全关的实际回执，再点停止并选择下一项。',
            ],
        },
        'enter': {
            'file': 'flow-9-prediction-entry.json',
            'label': '6分钟继续入区并反制',
            'sees': ['约50秒，无人机越过矩形左边界；约65秒到区内停留，持续上报至6分钟结束。平台确认实际入区后，查看关联实测告警。'],
            'todo': [
                '实际入区后打开关联实测告警，核对当前实测位置、入区依据和原预测预警的关联；短信电话回执在原预测预警中查看，实测告警按同次风险不重复通知。',
                '区内停留期间，按当前权限和有效证据办理：仍待核实时先人工核实，已核实则继续申请、由他人审批并执行反制；有既有直接反制权限时按原策略办理，已失效的预测授权不能复用。',
                '保留收发到6分钟结束，核对实际启动、停止回执及关联历史；通知或处置受阻时按页面原因处理，不能用场景时间代替业务条件。',
            ],
        },
    },
}

# 选择框说明采用 2026-10-16 最新验收口径：规则全满足且业务校验通过时自动反制，
# 无启用规则或条件不满足时由人工发起。自动核实只有流程 4 要关掉。
# auto_verify：这个流程要求自动核实的状态。True 打开，False 关闭，None 与自动核实无关。
GUIDE = {
    1: {
        'title': '违规无人机，通知后仍不走，自动反制',
        'shows': '有报备的无人机闯进禁飞区。系统核实后给飞手发短信、再打电话；无人机仍不离开，启用的反制规则全部满足且业务校验通过后自动反制。',
        'auto_verify': True,
        'before': [
            '规则管理里的核实规则保持启用：最近60秒至少两台不同设备，且最新观测不超过60秒。条件全部满足后自动核实。',
            '启用反制规则「高风险、最新观测不超过60秒」，确认本场景只有一台可用的模拟反制设备。',
        ],
        'sees': [
            '自动核实：告警出现后自动核实为属实（核实记录写「系统自动核实」）。',
            '飞手先收到短信，再接到电话；无人机一直待在禁飞区，告警变成「待反制」。',
        ],
        'todo': [
            '查看自动反制授权、设备启动及停止回执，再到「移送与处罚」核对自动移送、送达和签收回执。',
            '反制按钮供人工分支使用：未启用规则或规则不满足时，由有权限的人在当前证据有效时发起；不要重复发起已在执行的反制。',
        ],
    },
    2: {
        'title': '收到短信后飞离',
        'shows': '和流程 1 一样的违规，但飞手收到短信后把无人机飞走了。',
        'auto_verify': True,
        'before': [
            '规则管理里的「自动核实」保持打开。',
        ],
        'sees': [
            '自动核实：告警自动核实为属实，飞手收到短信。',
            '短信送达后，无人机沿撤离航线离开禁飞区；平台收到有效的新位置后才能判定撤离。固定等待为0秒，电话可能在撤离位置到达前已启动。',
            '收到撤离依据后不再启动后续反制；停报或位置未知不能算已飞离。已发生的通知和指令保留实际时间与结果。',
        ],
        'todo': [
            '查看短信送达、新位置、撤离确认与电话记录的先后顺序；若已有指令启动，同时核对停止结果，不把旧确认书的「不拨电话」当成0秒等待的保证。',
        ],
    },
    3: {
        'title': '没有报备的无人机',
        'shows': '没有飞行任务报备的无人机进入禁飞区。',
        'auto_verify': True,
        'before': [
            '规则管理里的「自动核实」保持打开。',
            '启用反制规则「高风险、最新观测不超过60秒」，确认本场景只有一台可用的模拟反制设备。',
        ],
        'sees': [
            '自动核实：出高风险告警，自动核实为属实。',
            '因为没有报备，系统查不到飞手联系方式，所以不发短信、不打电话，告警直接变成「待反制」。',
        ],
        'todo': [
            '查看规则通过后的自动反制授权、实际启停回执，以及自动移送和签收回执。',
            '反制按钮仅用于人工分支：规则未启用或不满足时，由有权限的人发起；当前证据、设备状态和授权仍须通过校验。',
        ],
    },
    4: {
        'title': '值班员核实为误报',
        'shows': '告警停在「待核实」，由值班员自己判断，这次判为误报。',
        'auto_verify': False,
        'warning': '开始前请先在规则管理关掉自动核实',
        'before': [
            '在规则管理的「核实」页里，把规则的开关都拨到「已停用」（没有启用的核实规则，系统就不会自动核实）。',
            '准备一个值班员账号，用来核实告警。',
        ],
        'sees': [
            '自动核实：这个流程不会发生，告警一直停在「待核实」，不发短信、不打电话。',
            '反制按钮：不会出现，因为你会把告警判为误报。',
        ],
        'todo': [
            '用值班员账号打开这条告警，核实为「误报」。',
            '确认没有短信、电话、反制或移送，并核对误报历史、统计及审计。结束后恢复刚才停用的核实规则。',
        ],
    },
    5: {
        'title': '中低风险，人工申请反制',
        'shows': '有报备的无人机偏离航线，风险等级中低，飞手通知后无人机仍不走。',
        'auto_verify': True,
        'before': [
            '告警要先核实通过，后面才会通知、才会走到反制：规则管理里的「自动核实」保持打开，或者由你在告警页手动核实。',
            '反制规则保持「高风险、最新观测不超过60秒」，本流程中低风险不满足自动条件；准备操作员和另一个有审批权限的账号。',
        ],
        'sees': [
            '自动核实：打开时自动发生；关着的话告警停在「待核实」，要你手动核实后才继续。',
            '出中低风险告警；核实后飞手先收到短信、再接到电话；无人机仍停留，告警变成「待反制」。',
        ],
        'todo': [
            '操作员申请反制，确认不能自行审批；换审批账号批准，再由操作员执行，核对启停回执及后续移送、送达和签收。',
            '反制按钮：本流程因不满足高风险规则走人工申请、审批和执行；目标有效上报期间办理，不能以按钮可点击代替权限和证据校验。',
        ],
    },
    6: {
        'title': '雷雨天气风险',
        'shows': '飞行任务时段内预报有雷雨，平台据此生成天气风险。',
        'auto_verify': None,
        'before': [
            '无需特别准备。',
        ],
        'sees': [
            '出一条天气风险，状态是「待核验」。',
            '自动核实和反制：不适用，天气风险由你人工核验。',
        ],
        'todo': [
            '在「全部风险事件」打开本次天气风险，核验后通知上级；在通知记录及模拟器收件箱核对接收对象、送达与回执。',
        ],
    },
    7: {
        'title': '航线附近 25 只鸟群',
        'shows': '25 只鸟群从任务航线附近飞过。',
        'auto_verify': None,
        'before': [
            '无需特别准备。',
        ],
        'sees': [
            '出鸟群风险，状态是「待核验」。',
            '自动核实和反制：不适用，鸟群风险由你人工核验。',
        ],
        'todo': [
            '在「全部风险事件」打开本次鸟群风险，核验后通知上级；在通知记录及模拟器收件箱核对接收对象、送达与回执。',
        ],
    },
    8: {
        'title': '设备故障、离线与恢复办结',
        'shows': '两台独立雷达分别故障和停止心跳，恢复后由后台核验，再人工确认办结。',
        'auto_verify': None,
        'before': ['准备业务前台和后台账号；无需修改核实或反制规则。'],
        'sees': [
            '开始时设备自动同步范围；在飞行任务选中本流程任务，右下角显示覆盖航线的设备。',
            '约30秒后，一台雷达报故障，另一台停止心跳；离线显示需等待平台心跳超时。后台检查后关联处置单。',
            '约3分钟后恢复心跳及明确健康上报；后台自动核验通过后显示「待确认办结」。',
            '自动核实和反制不适用，本流程不生成无人机目标。',
        ],
        'todo': [
            '前台查看设备状态和「查看设备处置进度」；有异常但尚未关联处置单时，可点「上报设备异常」。',
            '后台进入「运维管理 → 设备异常处理」，按设备找到两份处置单，分别点「接手处理」。',
            '等待两台设备恢复并显示「待确认办结」，分别点「确认办结」，核对前台待办消失和历史记录保留。',
            '完成办结后再停止模拟；停止上报可能再次产生离线异常。',
        ],
    },
    9: {
        'title': '预测入区预警',
        'shows': '一块矩形禁飞区，无人机从左向右直线接近。选5分钟转向避开，或6分钟继续入区并人工反制。空域和航线已内置。',
        'auto_verify': None,
        'prediction_only': True,
        'before': [
            '先在后台「运维管理 → 接口配置 → 电话通知录音」上传并选用预测进入禁飞区专用录音，确认模拟通知接收端及模拟反制设备可用。',
            '准备有核实、申请和执行权限的账号；普通申请仍需另一个有审批权限的账号审批，有既有直接反制权限的人可按原策略直接发起。',
            '本流程从预测预警开始，预测及其衍生处置不自动核实、不自动反制、不自动处罚；无需为此开启或关闭普通告警规则，权限、有效证据和设备校验保持。',
        ],
        'sees': [
            '先在融合感知选中无人机，查看未来10、20、30秒位置。约半分钟后留意预警；后台只预测未来30秒，预警是否成立及可办理时段以平台为准。',
            '预警出现且依据有效时，人工核实后按当前条件发送短信、播放预测专用电话录音；以实际送达和播放完成回执为准。',
            '模拟阶段提示只说明飞机飞到哪一步；预测线不是实测轨迹，反制仍需有权限人员人工发起。',
        ],
        'todo': [
            '预警出现且当前依据有效时点「核实预测风险」，核对已核实状态及冻结依据，再查看短信和电话的实际回执。',
        ],
    },
}


def _read_scene(folder, filename, number, variant=None):
    try:
        scene = json.loads(read_text(folder / filename))
    except (OSError, ValueError) as error:
        raise ValueError('流程文件读不出来：' + filename) from error
    fullchain = scene.get('fullchain') if isinstance(scene, dict) else None
    if (not isinstance(fullchain, dict) or scene.get('version') != 1
            or type(fullchain.get('acceptanceFlow')) is not int
            or fullchain['acceptanceFlow'] != number):
        raise ValueError('流程场景校验失败：' + filename)
    if number == 9 and (variant not in FLOW_VARIANTS[9]
                        or fullchain.get('predictionVariant') != variant):
        raise ValueError('流程预测变式校验失败：' + filename)
    return scene


def _minutes(scene):
    value = scene.get('duration')
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _guide(number, variant=None):
    guide = GUIDE[number]
    result = {key: guide.get(key) for key in ('shows', 'before', 'sees', 'todo', 'warning', 'auto_verify')}
    if number == 9:
        detail = FLOW_VARIANTS[9][variant or 'avoid']
        result['prediction_only'] = True
        result['sees'] = list(guide['sees']) + detail['sees']
        result['todo'] = list(guide['todo']) + detail['todo']
    return result


def _read_legacy_flows(root):
    """Read nine defaults and the fixed flow-9 variants without changing files."""
    folder = Path(root) / 'scenarios' / OUTPUT_NAME
    if not folder.is_dir():
        raise ValueError('找不到流程 1-9 的场景文件夹（scenarios/' + OUTPUT_NAME + '），请确认模拟器代码是完整的')
    manifest_path = folder / 'manifest.json'
    if not manifest_path.is_file():
        raise ValueError('流程文件夹里缺少 manifest.json')
    try:
        manifest = json.loads(read_text(manifest_path))
    except ValueError as error:
        raise ValueError('流程清单 manifest.json 读不出来：' + str(error)[:120]) from error
    if not isinstance(manifest, dict) or not isinstance(manifest.get('flows'), list):
        raise ValueError('流程清单必须包含流程 1-9 各一条')
    allowed = {filename: number for number, filename in FLOW_FILES.items()}
    flows = []
    for item in manifest['flows']:
        filename = item.get('file') if isinstance(item, dict) else None
        if not isinstance(filename, str) or filename not in allowed:
            raise ValueError('流程清单里有不认识的文件')
        number = allowed[filename]
        scene = _read_scene(folder, filename, number, 'avoid' if number == 9 else None)
        guide = GUIDE[number]
        flow = {
            'flow': number,
            'file': filename,
            'name': scene.get('name', filename),
            'title': guide['title'],
            'minutes': _minutes(scene),
            'scene': scene,
            'guide': _guide(number),
            'expectedChecks': scene.get('fullchain', {}).get('expectedChecks', []),
        }
        if number == 9:
            flow['default_variant'] = 'avoid'
            flow['variants'] = []
            for variant_id, variant in FLOW_VARIANTS[9].items():
                variant_scene = scene if variant['file'] == filename else _read_scene(folder, variant['file'], number, variant_id)
                flow['variants'].append({
                    'id': variant_id,
                    'label': variant['label'],
                    'scene': variant_scene,
                    'minutes': _minutes(variant_scene),
                    'guide': _guide(number, variant_id),
                })
        flows.append(flow)
    if sorted(item['flow'] for item in flows) != sorted(FLOW_FILES):
        raise ValueError('流程清单必须包含流程 1-9 各一条')
    return {'status': 'READY_FOR_IMPORT', 'flows': sorted(flows, key=lambda item: item['flow'])}


def read_acceptance_flows(root):
    """Daily flows share one risk journey; old flow 9 is import/history compatibility only."""
    from unified_risk_flows import integrate
    from adsb_flights import flight_flow
    legacy = _read_legacy_flows(root)
    flows = integrate(legacy['flows'])
    # 流程 10「反制前附近有航班」由流程 5 的无人机加上模拟航班组成（2026-10-26）。
    flows.append(flight_flow(next(flow for flow in legacy['flows'] if flow['flow'] == 5)))
    return dict(status=legacy['status'], flows=flows,
                compatibility_flows=[flow for flow in legacy['flows'] if flow['flow'] == 9])
