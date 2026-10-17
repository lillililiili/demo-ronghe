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

# 选择框右边的说明。措辞以规则与做法确认书为准；"自动核实""反制按钮"两件事写进每个流程里：
# 反制在主线上永远是人工发起（规则只评估资格），自动核实只有流程 4 要关掉。
# auto_verify：这个流程要求自动核实的状态。True 打开，False 关闭，None 与自动核实无关。
GUIDE = {
    1: {
        'title': '违规无人机，通知后仍不走，人工反制',
        'shows': '有报备的无人机闯进禁飞区。系统先给飞手发短信、再打电话，无人机仍不离开，最后由有反制权限的人手动发起反制。',
        'auto_verify': True,
        'before': [
            '规则管理里的「自动核实」保持打开。打开时，告警出来后系统会自己核实为属实，不用你点。',
            '准备一个有反制权限的账号（比如管理员）。',
        ],
        'sees': [
            '自动核实：告警出现后自动核实为属实（核实记录写「系统自动核实」）。',
            '飞手先收到短信，再接到电话；无人机一直待在禁飞区，告警变成「待反制」。',
        ],
        'todo': [
            '告警变成「待反制」后，用有反制权限的账号点「发起反制」，看到设备启动；再点停止，看到停止回执。',
            '反制按钮：告警走到「待反制」、而且目标还在持续上报时才会亮；流程跑完后目标不再上报，按钮会变灰，所以要在流程还在跑的时候点。反制不会自动发起，规则只判断够不够条件。',
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
            '短信送达后，无人机沿撤离航线离开禁飞区；平台按实际位置判定已飞离，不再打电话，也不会进入「待反制」。',
            '反制按钮：这个流程不会出现，因为飞手已经飞离。',
        ],
        'todo': [
            '只需要查看告警和通知记录，不用反制。',
        ],
    },
    3: {
        'title': '没有报备的无人机',
        'shows': '没有飞行任务报备的无人机进入禁飞区。',
        'auto_verify': True,
        'before': [
            '规则管理里的「自动核实」保持打开。',
            '准备一个有反制权限的账号（比如管理员）。',
        ],
        'sees': [
            '自动核实：出高风险告警，自动核实为属实。',
            '因为没有报备，系统查不到飞手联系方式，所以不发短信、不打电话，告警直接变成「待反制」。',
        ],
        'todo': [
            '由有反制权限的账号决定要不要手动发起反制。',
            '反制按钮：告警变成「待反制」、目标还在持续上报时才会亮，要在流程还在跑的时候点；反制不会自动发起。',
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
            '跑完请回规则管理，把刚才停用的核实规则重新拨回「已启用」，否则流程 1、2 不会自动核实。',
        ],
    },
    5: {
        'title': '中低风险，人工申请反制',
        'shows': '有报备的无人机偏离航线，风险等级中低，飞手通知后无人机仍不走。',
        'auto_verify': True,
        'before': [
            '告警要先核实通过，后面才会通知、才会走到反制：规则管理里的「自动核实」保持打开，或者由你在告警页手动核实。',
            '准备两个账号：值班员（申请反制）和另一个有审批权限的账号（审批）。',
        ],
        'sees': [
            '自动核实：打开时自动发生；关着的话告警停在「待核实」，要你手动核实后才继续。',
            '出中低风险告警；核实后飞手先收到短信、再接到电话；无人机仍停留，告警变成「待反制」。',
        ],
        'todo': [
            '值班员账号申请反制，换审批账号批准，然后按页面提示执行，并看设备回执。',
            '反制按钮：全程手动（申请、审批、执行），系统不会自动反制。',
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
            '在风险事件页面核验这条风险，并通知上级。',
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
            '在「全部风险事件」页面核验这条风险，并通知上级。',
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
