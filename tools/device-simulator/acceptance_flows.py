"""七个验收流程：直接读仓库里现成的 7 份流程文件，配上选择框里的说明文字。

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
}


def read_acceptance_flows(root):
    """Read the seven flow files under <root>/scenarios and attach the picker guide to each."""
    folder = Path(root) / 'scenarios' / OUTPUT_NAME
    if not folder.is_dir():
        raise ValueError('找不到流程 1-7 的场景文件夹（scenarios/' + OUTPUT_NAME + '），请确认模拟器代码是完整的')
    manifest_path = folder / 'manifest.json'
    if not manifest_path.is_file():
        raise ValueError('流程文件夹里缺少 manifest.json')
    try:
        manifest = json.loads(read_text(manifest_path))
    except ValueError as error:
        raise ValueError('流程清单 manifest.json 读不出来：' + str(error)[:120]) from error
    allowed = set(FLOW_FILES.values())
    flows = []
    for item in manifest.get('flows', []):
        filename = item.get('file') if isinstance(item, dict) else None
        if filename not in allowed:
            raise ValueError('流程清单里有不认识的文件')
        try:
            scene = json.loads(read_text(folder / filename))
        except (OSError, ValueError) as error:
            raise ValueError('流程文件读不出来：' + filename) from error
        number = scene.get('fullchain', {}).get('acceptanceFlow') if isinstance(scene, dict) else None
        if scene.get('version') != 1 or number not in FLOW_FILES or FLOW_FILES[number] != filename:
            raise ValueError('流程场景校验失败：' + filename)
        guide = GUIDE[number]
        minutes = scene.get('duration')
        flows.append({
            'flow': number,
            'file': filename,
            'name': scene.get('name', filename),
            'title': guide['title'],
            'minutes': minutes if isinstance(minutes, (int, float)) and not isinstance(minutes, bool) else None,
            'scene': scene,
            'guide': {key: guide.get(key) for key in ('shows', 'before', 'sees', 'todo', 'warning', 'auto_verify')},
            'expectedChecks': scene.get('fullchain', {}).get('expectedChecks', []),
        })
    if sorted(item['flow'] for item in flows) != sorted(FLOW_FILES):
        raise ValueError('流程清单必须包含流程 1-7 各一条')
    return {'status': 'READY_FOR_IMPORT', 'flows': sorted(flows, key=lambda item: item['flow'])}
