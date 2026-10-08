"""Export fresh topic/payload templates for MQTTX. No automatic MQTT publishing."""
import argparse
import copy
import json
from pathlib import Path
import time
from engine import compile_scene, messages
from full_scenario import allocate_identities
from platform_client import stable_device_identity
from protocol_b import decode


def receipts(command_topic, command):
    """Build isolated negative cases from an actually captured platform command."""
    parts=command_topic.split('/')
    if len(parts)!=5 or parts[0]!='bridge' or parts[2]!='device_control' or any(not p or any(c in p for c in '+#\x00') for p in parts):
        raise ValueError('请提供本批次实际收到的协议 B 控制主题')
    decode(command_topic,json.dumps(command).encode(),{'external_id':parts[4],'kind':parts[3]})
    head,data=command['head'],command['data']
    response={'head':{'msgNo':head['msgNo'],'deviceId':head['deviceId'],'time':int(time.time()*1000)},
              'data':{'operationType':data['operationType'],'operationCmd':data['operationCmd'],'code':0,'msg':''}}
    topic='/'.join([parts[0],parts[1],'device_control_resp',parts[3],parts[4]])
    original={'case':'success','topic':topic,'payload':response,'qos':1,'retain':False}
    rows=[original]
    for label,mutate in [('failure',lambda r:r['payload']['data'].update(code=1,msg='模拟失败')),
                         ('duplicate',lambda r:None),
                         ('wrong-msg-no',lambda r:r['payload']['head'].update(msgNo=head['msgNo']+'-wrong')),
                         ('wrong-device',lambda r:r['payload']['head'].update(deviceId='not-this-device')),
                         ('wrong-source',lambda r:r.update(topic=topic.replace('/'+parts[1]+'/', '/item1-wrong-provider/',1))),
                         ('retained',lambda r:r.update(retain=True))]:
        row=copy.deepcopy(original);row['case']=label;mutate(row);rows.append(row)
    return {'note':'仅用于隔离异常注入；须来自本批次实际指令，逐项测试，不批量发布。成功回执不证明实物动作。','messages':rows}


def export(scene, manifest=None):
    now=int(time.time()*1000)
    scene, devices, targets, _=compile_scene(scene)
    manifest=manifest or {'provider':'map-sim','batch':'item1-mqttx','devices':{
        key:{'external_id':stable_device_identity(key,d['kind'])} for key,d in devices.items()},
        'targets':allocate_identities(scene,'item1-mqttx')}
    records=[{'case':'normal','topic':t,'payload':p,'qos':1,'retain':False}
             for t,p in messages(scene,devices,targets,manifest,0,now,{},now%2147483648)]
    observation=next((r for r in records if '/device_data/' in r['topic']),None)
    if observation:
        for label, mutate in [('duplicate',lambda r:None),('wrong-device',lambda r:r['payload'].update(deviceId='not-this-device')),
                              ('invalid-counter',lambda r:r['payload'].update(msgCnt=-1)),('retained',lambda r:r.update(retain=True)),
                              ('qos-zero',lambda r:r.update(qos=0))]:
            row=copy.deepcopy(observation);row['case']=label;mutate(row);records.append(row)
    return {'generated_at':now,'note':'先正常消息，异常逐条独立发送。非MQTTX连接配置；不含凭据。请在运行前重新导出。', 'messages':records}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scene',type=Path,nargs='?');parser.add_argument('--manifest',type=Path);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--control-command',type=Path);parser.add_argument('--command-topic')
    args=parser.parse_args()
    if args.control_command:
        if args.scene or args.manifest or not args.command_topic: parser.error('协议 B 需 --control-command 和 --command-topic；不同时传场景')
        result=receipts(args.command_topic,json.loads(args.control_command.read_text(encoding='utf-8-sig')))
    else:
        if not args.scene or args.command_topic: parser.error('协议 A 需提供场景文件')
        result=export(json.loads(args.scene.read_text(encoding='utf-8-sig')),
                      json.loads(args.manifest.read_text(encoding='utf-8-sig')) if args.manifest else None)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
