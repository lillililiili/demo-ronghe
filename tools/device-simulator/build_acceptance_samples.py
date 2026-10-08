"""Create reproducible item-1 input files. Does not connect to or write the platform."""
import copy
import json
from pathlib import Path


def base(name, kinds=('tdoa',)):
    devices=[{'id':'item1-'+kind,'name':'验收模拟 '+kind,'kind':kind,'health':'正常',
              'heartbeat':'持续上报','interval':2} for kind in kinds]
    targets=[{'id':'item1-t-'+kind,'name':'验收目标 '+kind,'kind':'uav','deviceId':'item1-'+kind,
              'path':[[470+i*300,300],[490+i*300,300]],'height':100,'heightAgl':60,'speed':2,
              'motionMode':'pingpong','transport':'mqtt','planId':'','uavSn':'SIM-ITEM1-'+kind.upper(),
              'protocolA':{'uavModel':'SIM-SAME-MODEL','channel':'5.73','bandWidth':'10.00','reportSn':True}}
             for i,kind in enumerate(kinds) if kind in ('radar','5ga','tdoa','aoa','dcd','rid')]
    return {'version':1,'name':name,'duration':2,'sites':[{'id':'item1-site','name':'验收模拟设备组',
             'x':450,'y':300,'devices':devices}], 'targets':targets,'plans':[],'zones':[],'risks':[],
             'fullchain':{'enabled':True,'categories':[]}}


def samples():
    result={}
    result['01-six-types']=base('01 六类协议 A 正常输入',('radar','5ga','tdoa','aoa','dcd','rid'))
    s=base('02 TDOA 型号完整但缺 SN');s['targets'][0]['protocolA']['reportSn']=False
    result['02-missing-sn']=s
    s=base('03 同型号不同 SN');other=copy.deepcopy(s['targets'][0]);other.update(id='item1-t-two',name='同型号第二目标',uavSn='SIM-ITEM1-TWO',path=[[770,300],[790,300]])
    s['targets'].append(other);result['03-same-model']=s
    s=base('04 雷达和 TDOA 同目标',('radar','tdoa'));s['targets']=s['targets'][:1]
    # Keep this pair stable across repeats, but separate from the independent
    # target scenarios whose existing source links must not be reassigned.
    for device in s['sites'][0]['devices']:
        device['id']='item1-multi-'+device['kind'];device['name']='多源验收模拟 '+device['kind']
    s['targets'][0]['deviceId']='item1-multi-radar';s['targets'][0]['secondaryDeviceId']='item1-multi-tdoa'
    result['04-multi-source']=s
    result['05-aoa-bearing']=base('05 AOA 方位观测',('aoa',))
    s=base('06 在线但无目标',('radar',));s['targets']=[];s['sites'][0]['devices'][0]['emitEmpty']=True
    result['06-empty-frame']=s
    s=base('07 目标停报但设备继续在线');s['targets'][0]['silenceWindows']=[{'at':10,'seconds':100}]
    result['07-target-silence']=s
    s=base('08 航线任务受控资料回读');s['targets'][0]['planId']='item1-plan'
    s['plans']=[{'id':'item1-plan','name':'验收模拟航线','points':[[470,300],[490,300]],
                 'min':0,'max':150,'width':100,'start':'00:01','end':'23:59','altitudeDatum':'AMSL'}]
    result['08-controlled-inputs']=s
    for name,cfg in [('success',{}),('failure',{'response':'failure'}),('no-receipt',{'response':'no_receipt'}),
                     ('late',{'delayMs':120000}),('duplicate',{'duplicateCount':1})]:
        s=base('协议 B '+name,('dec','ifr','bsc','radar','tdoa','aoa'));s['targets']=[]
        for d in s['sites'][0]['devices']:d['protocolB']={'enabled':True,'response':'success',**cfg}
        s['duration']=5
        result['b-'+name]=s
    return result


if __name__=='__main__':
    output=Path(__file__).parent/'scenarios'/'item1'
    output.mkdir(parents=True,exist_ok=True)
    for name,scene in samples().items():
        (output/(name+'.json')).write_text(json.dumps(scene,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
