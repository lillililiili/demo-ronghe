"""Compose daily risk branches from observation-only scenes; never write platform outcomes."""
import copy
import math

from engine import compile_scene, metres
from k03_warning_flow import build_scenes


TITLES = {1: '接近禁飞区并继续入区', 2: '收到短信后转向避开',
          3: '无报备无人机风险', 4: '人工核实为误报'}


def prediction_scene(number, **geometry):
    if number not in TITLES:
        raise ValueError('预警分支只用于流程 1、2、3、4')
    geometry.setdefault('identity', 'unified-risk-flow-' + str(number))
    scene = build_scenes(**geometry)['avoid' if number == 4 else 'enter']
    target = scene['targets'][0]
    scene['name'] = f'流程 {number} · {TITLES[number]}'
    target['name'] = '演示无人机' if number != 3 else '无报备无人机'
    # These scenes have new source identities. Existing flow-9 files and published
    # airspaces keep their geometry and source keys, including legacy imports.
    scene['fullchain'].update(acceptanceFlow=number, riskBranch='prediction')
    scene['fullchain'].pop('predictionVariant', None)
    for site in scene['sites']:
        for device in site['devices']:
            device['name'] = '模拟' + {'radar': '雷达', 'tdoa': 'TDOA', 'eo': '光电'}[device['kind']]
            if device.get('coverage'):
                device['coverage']['sourceLabel'] = '统一风险场景配置：模拟光电视场'
    scene['countermeasure'] = {'coverage': {'kind': 'circle', 'radiusM': 2500,
        'sourceLabel': '统一风险场景配置：模拟反制设备作用半径'}}
    if number == 2:
        # No timer substitutes for delivery. Until the platform's real simulated
        # SMS receipt arrives, the aircraft continues on its approach/entry path.
        start, end = target['path'][0], target['path'][-1]
        target.update(notificationBehavior='after_sms', departureSpeed=target['speed'],
                      departurePath=[copy.deepcopy(start),
                                     [start[0] - abs(end[0] - start[0]) / 4, start[1]]])
        scene['sceneGuide']['summary'] = '直线接近矩形禁飞区；收到本次风险短信送达回执后向左返回，未收到则继续原航线。'
        scene['sceneGuide']['stages'] = scene['sceneGuide']['stages'][:2]
        scene['sceneGuide']['stages'][1]['description'] = '预警阶段人工核实；未核实并继续入区时查看后台规则结果。转向由真实模拟短信送达回执触发，具体时刻不预设。'
        scene['mapGuide']['markers'] = [scene['mapGuide']['markers'][0]]
        scene['mapGuide']['directions'] = scene['mapGuide']['directions'][:1]
        scene['mapGuide']['markers'].append({'id': 'return', 'role': 'end',
            'label': '短信送达后向左返回', 'point': copy.deepcopy(target['departurePath'][-1])})
    if number == 3:
        target['planId'] = ''
        target.pop('pilotPoint', None)
        scene['plans'] = []
    for site in scene['sites']:
        for device in site['devices']:
            if device['kind'] == 'eo':
                extent = max(metres([site['x'], site['y']], point)
                             for point in target['path'] + target.get('departurePath', []))
                device['coverage']['rangeM'] = max(device['coverage']['rangeM'], math.ceil(extent / 100) * 100 + 100)
    for stage in scene['sceneGuide']['stages']:
        if '提前预警' in stage['label'] and number != 2:
            stage['description'] = '预警阶段可人工核实；验证入区自动衔接时暂不提交，在同一条风险查看后续状态，可查看光电模拟视频。'
        if '飞入禁飞区' in stage['label']:
            stage['description'] = '同一风险更新为已实际入区；未核实时按后台启用规则判断，全部满足且入区依据有效才自动核实；已核实不重复，继续查看原记录和通知进度。'
    if number == 4:
        scene['sceneGuide']['stages'][1]['description'] = '在统一风险详情人工核实为误报，核对后续通知和反制不会启动；模拟航线仍按观测继续。'
    scene['fullchain']['expectedChecks'] = prediction_guide(number)['sees']
    compile_scene(scene)
    return scene


def prediction_guide(number):
    guide = {
        'prediction_only': True, 'includes_observed_stage': number != 4, 'auto_verify': None, 'warning': '',
        'shows': '无人机从左向右直线接近矩形禁飞区，提前预警与实际入区使用同一条无人机风险办理记录。',
        'before': ['预警阶段人工核实；实际入区时若尚未核实，后台启用的核实条件全部满足且本区实测依据有效才自动核实，否则继续人工核实。',
                   '查看后台核实规则的实际启用状态；模拟器不替你开关规则。预测衍生风险的反制仍由有权限人员人工发起。',
                   '确认模拟短信、电话及预测用途录音可用；未配置或没有飞手资料时按平台提示处理。',
                   '处置顺序以后台当前策略和本风险资格为准；模拟器只读配置，不替用户启用规则。'],
        'sees': ['未来10／20／30秒虚线预测与实测轨迹区分；有效风险可排队光电跟踪，媒体就绪后查看带模拟标识的视频。',
                 '预警转实际入区更新同一风险、同一待办；尚未核实才判断自动核实，已核实不重复办理，短信和电话各按同次风险防重。',
                 '命中反制优先策略时短信并行、反制不等电话；真实启动回执后且风险持续才拨电话，明确无法启动或失败、最长等待到期进入电话资格判断。'],
        'todo': ['在融合感知或告警处置打开同一条无人机风险：预警时可人工核实；要验证自动衔接，可暂不提交，待实际入区后查看系统核实记录或具体阻断原因。',
                 '按允许动作人工申请、由不同人员审批后执行，或使用已有直接反制权限；查看真实启动和停止回执。',
                 '结束后点停止；预测核实和预测处置记录不能作为实际违法或处罚移送依据。']}
    if number == 2:
        guide['shows'] = '无人机从区外接近；风险经人工或入区后的规则核实后，只有本次风险的模拟短信真实送达才向左返回。'
        guide['sees'][1] = '同一次风险已核实不重复办理，短信和电话不重复发送。短信送达后转向；连续新实测确认当前和完整预测轨迹均避开该区域，平台撤销风险并取消后续通知、停止预测处置。'
        guide['todo'] = ['出现提前预警后及时人工核实，查看真实短信回执及随后向左返回的航迹。',
                        '没有短信送达时继续原航迹；若实际入区且尚未核实，按后台规则判断自动核实，再依据实际短信回执转向。',
                        '在同一风险核对已避开、撤销原因和历史；已受理电话保留真实回执，不能承诺已经拨出的电话被撤回。']
    elif number == 3:
        guide['shows'] = '无报备无人机从区外接近并继续入区；没有飞手联系方式时，短信和电话如实显示不可通知。'
        guide['before'][2] = '本分支不创建飞行计划、飞手位置或联系方式；核对通知受阻原因，不补造通知成功。'
        guide['sees'].append('缺少飞手资料阻断通知；反制是否可办由当前顺序策略、权限、设备和有效证据共同判断。')
    elif number == 4:
        guide['shows'] = '区外接近产生提前预警，由值班员在统一风险页面核实为误报；本场景在区外转向，不演示实测入区后的自动核实。'
        guide['before'][0] = '出现预警时人工核实为误报；本场景全程在区外，预警不自动核实，无需关闭普通核实规则。'
        guide['todo'] = ['出现有效提前预警后，人工选择核实为误报并提交。',
                        '核对风险进入历史且没有自动短信、电话和反制；不要将观测中的后续转向当作人工核实结论。']
    return guide


def inside_scene(original):
    scene = copy.deepcopy(original)
    scene['fullchain']['riskBranch'] = 'inside'
    number = scene['fullchain']['acceptanceFlow']
    if number in (1, 2):
        # The direct-observation branch intentionally begins inside its own zone,
        # with original plan/device identities. Never change the saved old scene.
        corners = scene['zones'][0]['points']
        center = [sum(p[i] for p in corners) / len(corners) for i in (0, 1)]
        target = scene['targets'][0]
        target['path'] = [center]
        target.pop('dwellSeconds', None)
    scene['name'] = f'流程 {number} · 首次发现已在区内'
    compile_scene(scene)
    return scene


def observed_guide(number, original):
    guide = copy.deepcopy(original)
    if number not in (1, 2, 3, 5):
        return guide
    guide['before'] = [text for text in guide['before'] if '反制规则' not in text]
    guide['before'].append('自动反制只在启用规则全部满足且服务端业务校验通过时发生；处置顺序独立按后台当前策略判断。')
    guide['shows'] = {1: '首次发现目标时已在禁飞区，按现有实测核实与反制规则处置。',
        2: '首次发现目标时已在禁飞区，收到本次风险短信真实送达回执后飞离。',
        3: '首次发现无报备目标时已在禁飞区，缺少飞手联系方式时如实记录不可通知。',
        5: '中低风险偏航使用统一风险页面，保留人工申请、不同人员审批和执行。'}[number]
    guide['sees'] = ['核实规则启用且全部满足后自动核实；不满足时按平台提示人工核实。',
        '在同一无人机风险查看短信、反制、电话进度。命中反制优先策略时短信并行、反制不等待短信送达或电话；未命中时沿用通知优先。',
        ('短信送达后沿撤离航线离开；以新观测与电话、反制实际时序验收，停报不算已离开。'
         if number == 2 else '实际通知、反制启动与停止结果均以通道和设备回执为准。')]
    if number == 3:
        guide['sees'].append('无报备且缺少已核验飞手，短信和电话显示不可通知，不能注入成功回执。')
    guide['todo'] = ['融合感知或告警处置打开同一条无人机风险，按当前阶段、允许动作及阻断原因办理。',
        '反制按钮资格由后端返回；有申请权限的人申请、不同人员审批、执行，或按已有直接权限操作。',
        '等待真实启动和停止回执；电话后置时查看启动确认、明确失败或最长等待到期后的电话资格判断。']
    if number in (1, 3):
        guide['todo'].append('独立实测风险保留原自动规则；规则不满足时由有权限的人发起，不能把预测衍生风险当作独立实测自动反制。')
    return guide


def integrate(legacy):
    result = []
    for original in legacy:
        number = original['flow']
        if number == 9:
            continue
        item = copy.deepcopy(original)
        if number in TITLES:
            old_scene = inside_scene(original['scene']) if number in (1, 2, 3) else copy.deepcopy(original['scene'])
            old_guide = observed_guide(number, original['guide'])
            old_guide['todo'] = ['在统一无人机风险页面办理，阶段和通知、反制进度分别查看。'] + old_guide['todo']
            old_scene['fullchain']['expectedChecks'] = copy.deepcopy(old_guide['sees'])
            old = dict(id='inside' if number != 4 else 'observed_false_alarm',
                       label='首次发现已在区内（补充场景）' if number != 4 else '实测风险核实为误报',
                       minutes=old_scene['duration'], scene=old_scene, guide=old_guide, supplemental=number != 4)
            new_scene = prediction_scene(number)
            predicted = dict(id='prediction', label=('完整流程：区外预警 → 短信后转向' if number == 2 else '完整流程：区外预警 → 入区按规则核实') if number != 4 else '预测风险核实为误报',
                             minutes=new_scene['duration'], scene=new_scene, guide=prediction_guide(number))
            item.update(title=TITLES[number], variants=[predicted, old] if number != 4 else [old, predicted],
                        default_variant='prediction' if number != 4 else 'observed_false_alarm')
            default = item['variants'][0]
            item.update({key: default[key] for key in ('minutes', 'scene', 'guide')})
            item['name'] = item['scene']['name']
            item['expectedChecks'] = copy.deepcopy(item['scene']['fullchain']['expectedChecks'])
        elif number == 5:
            item['guide'] = observed_guide(number, original['guide'])
        result.append(item)
    return result
