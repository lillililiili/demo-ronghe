"""Read existing simulated notification facts. Never bind, dispatch or acknowledge."""
import re
from concurrent.futures import ThreadPoolExecutor

SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')

def _read_many(rows, reader):
    def read(row):
        try:
            return reader(row), None
        except ValueError as error:
            if '返回 401' in str(error): raise
            return [], str(error)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(read, rows))
    return [item for items, _ in results for item in items], [error for _, error in results if error]

def read_inbox(platform, kind, page=1):
    if kind not in ('sms', 'voice', 'risk', 'punishment', 'plan_feedback', 'device_maintenance') or not 1 <= page <= 10000:
        raise ValueError('通知类别或页码无效')
    if kind in ('sms', 'voice'):
        context = platform.call('GET', '/local-interface-simulator/context')
        events = [row for row in context.get('sources', []) if row.get('source_kind') == 'UAV_EVENT' and SAFE_ID.fullmatch(row.get('source_id', ''))]
        def advisory(event):
            result = platform.call('GET', '/uav-events/'+event['source_id']+'/advisory')
            records = []
            for row in result.get('records', []):
                if row.get('simulated') is not True or row.get('kind') != ('SMS_SIMULATED' if kind == 'sms' else 'VOICE_SIMULATED'): continue
                status = row.get('delivery_status') or 'UNKNOWN'
                received = status in ('SIMULATED_DELIVERED', 'SIMULATED_PLAYED')
                records.append({'id': row['record_id'], 'kind': kind, 'subject': event.get('label') or event['source_id'],
                    'recipient': row.get('recipient_name'), 'content': row.get('content'), 'status': status,
                    'received': received, 'at': row.get('created_at'), 'time_label': '记录时间', 'details': row})
            return records
        rows, errors = _read_many(events, advisory)
        errors += [value for value in context.get('unavailable_sections', []) if '告警' in value]
        scope = '最近 100 个可见模拟告警中的通知记录'
        more = False
    elif kind == 'plan_feedback':
        plans = platform.call('GET', f'/flight-plans?page={page}&size=20')
        visible = [row for row in plans.get('items', []) if row.get('source_mode') in ('mock', 'replay')
                   and SAFE_ID.fullmatch(row.get('plan_id', ''))]
        def feedback(plan):
            history = platform.call('GET', '/flight-plans/'+plan['plan_id']+'/verifications')
            verifications = {row.get('verification_id'): row for row in history.get('verifications', [])}
            result = []
            for row in history.get('feedback', []):
                if not SAFE_ID.fullmatch(row.get('feedback_id', '')): continue
                verification = verifications.get(row.get('verification_id')) or {}
                status = row.get('delivery_status') or 'UNKNOWN'
                result.append({'id': row['feedback_id'], 'kind': kind, 'subject': plan.get('plan_no') or plan['plan_id'],
                    'recipient': row.get('recipient_name'),
                    'content': verification.get('evidence') or row.get('processing_result') or '计划核实回告内容未提供，请展开查看原始记录。',
                    'status': status, 'receipt_status': row.get('receipt_status'), 'received': status == 'DELIVERED',
                    'at': row.get('delivered_at') or row.get('submitted_at') or row.get('created_at'),
                    'time_label': '送达时间' if row.get('delivered_at') else '发送记录时间',
                    'reason': row.get('blocked_reason'), 'details': {'feedback': row, 'verification': verification}})
            return result
        rows, errors = _read_many(visible, feedback)
        more = plans.get('total', 0) > page * 20
        scope = '当前账号可见的模拟飞行计划 · 每页最多 20 个关联计划'
    elif kind == 'device_maintenance':
        tasks = platform.call('GET', f'/device-maintenance-tasks?status=ALL&page={page}&size=20')
        rows = []
        for task in tasks.get('items', []):
            if task.get('simulated') is not True: continue
            for attempt in task.get('notification_attempts') or []:
                if not SAFE_ID.fullmatch(attempt.get('attempt_id', '')): continue
                status = attempt.get('delivery_status') or 'UNKNOWN'
                recipient = attempt.get('recipient_snapshot') or {}
                rows.append({'id': attempt['attempt_id'], 'kind': kind,
                    'subject': task.get('device_name') or task.get('device_no') or task.get('task_id'),
                    'recipient': recipient.get('recipient_name'),
                    'content': task.get('reason') or '设备运维通知事由未提供，请展开查看原始记录。',
                    'status': status, 'receipt_status': attempt.get('receipt_status'), 'received': status == 'DELIVERED',
                    'at': attempt.get('delivered_at') or attempt.get('submitted_at') or attempt.get('requested_at'),
                    'time_label': '送达时间' if attempt.get('delivered_at') else '发送记录时间',
                    'reason': attempt.get('blocked_reason'), 'details': {'task': task, 'notification': attempt}})
        errors = []
        more = tasks.get('total', 0) > page * 20
        scope = '当前账号可见的模拟设备运维通知 · 每页最多 20 个关联任务'
    else:
        handoff_type = 'RISK_NOTICE' if kind == 'risk' else 'UAV_PUNISHMENT'
        source_kind = 'RISK' if kind == 'risk' else 'UAV_EVENT'
        handoffs, errors, more = [], [], False
        for mode in ('mock', 'replay'):
            try:
                result = platform.call('GET', f'/handoffs?source_kind={source_kind}&source_mode={mode}&page={page}&size=20')
                handoffs += result.get('items', [])
                more = more or result.get('total', 0) > page*20
            except ValueError as error:
                if '返回 401' in str(error): raise
                errors.append(str(error))
        def handoff(row):
            hid = row.get('handoff_id', '')
            if row.get('source_mode') not in ('mock', 'replay') or row.get('handoff_type') != handoff_type or not SAFE_ID.fullmatch(hid): return []
            detail = platform.call('GET', '/handoffs/'+hid)
            material = detail.get('material') or {}
            source = material.get('risk') or material.get('event') or {}
            content = source.get('reason_text') or source.get('alarm_type') or ''
            # Each delivery attempt retains its own status and recorded time.
            deliveries, delivery_page = [], 1
            while True:
                result = platform.call('GET', f'/handoffs/{hid}/deliveries?page={delivery_page}&size=100')
                deliveries += result.get('items', [])
                if not result.get('items') or len(deliveries) >= result.get('total', 0): break
                delivery_page += 1
            return [{'id': d['delivery_id'], 'kind': kind, 'subject': detail.get('source_no') or row.get('source_no') or row.get('source_id'),
                'recipient': detail.get('recipient_name'), 'content': content or '通知正文未提供，可展开查看已保存的通知材料。',
                'status': d.get('delivery_status') or 'UNKNOWN', 'receipt_status': d.get('receipt_status'),
                'received': d.get('delivery_status') == 'DELIVERED',
                'at': d.get('delivered_at') or d.get('submitted_at') or d.get('created_at'),
                'time_label': '送达时间' if d.get('delivered_at') else '发送记录时间',
                'reason': d.get('blocked_reason'), 'details': {'notification': d, 'material': material, 'availability': detail.get('availability')}} for d in deliveries]
        rows, failures = _read_many(handoffs, handoff)
        errors += failures
        scope = '当前账号可见的模拟通知 · 每页最多 40 个关联事项'
    rows.sort(key=lambda row: row.get('at') or 0, reverse=True)
    return {'items': rows, 'errors': list(dict.fromkeys(errors)), 'scope': scope, 'page': page, 'has_more': more}
