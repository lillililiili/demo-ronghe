"""Build explicit simulated forecasts for the plans actually accepted by a batch."""
import copy
import hashlib
import json


def batch_forecasts(scene, manifest, extra_plans=None):
    if 'weather' not in scene.get('fullchain', {}).get('categories', []):
        return []
    plans = copy.deepcopy(manifest.get('plan_expectations', {}))
    required = {pid for route in manifest.get('plans', {}).values() for pid in route.get('ids', [])}
    if not required or not required.issubset(plans):
        raise ValueError('本批任务回执或时段不完整，不能确认天气已全部配套')
    for pid, expected in (extra_plans or {}).items():
        if pid in plans and plans[pid] != expected:
            raise ValueError('同一模拟任务的时段资料不一致')
        plans[pid] = copy.deepcopy(expected)
    weather = scene.get('fullchain', {}).get('weather', {})
    return [plan_forecast(manifest['batch'], pid, plans[pid], weather, manifest['created_at'])
            for pid in sorted(required | set(extra_plans or {}))]


def plan_forecast(batch, plan_id, plan, weather, created_at):
    if plan.get('source_mode') not in ('mock', 'replay'):
        raise ValueError('演示天气只能关联明确的模拟任务')
    start, finish = plan.get('start_at'), plan.get('end_at')
    if (not plan_id or type(start) is not int or type(finish) is not int
            or start <= 0 or finish <= start or type(created_at) is not int or created_at <= 0):
        raise ValueError('模拟任务编号或飞行时段不完整，不能配套天气预报')
    periods = copy.deepcopy(weather.get('periods'))
    if not periods:
        periods = [{'from': start, 'to': finish, 'summary': weather.get('summary', '模拟多云'),
                    'temperature_c': weather.get('temperature_c', 22),
                    'wind_speed_ms': weather.get('wind_speed_ms', 6),
                    'gust_ms': weather.get('gust_ms', 11),
                    'wind_direction_deg': int(weather.get('wind_from_degrees', 90)),
                    'precipitation_probability_pct': weather.get('precipitation_probability_pct', 40),
                    'humidity_pct': int(weather.get('humidity_percent', 65))}]
    # These are simulated scenario times, not a claim that a real forecast was issued then.
    # The platform independently records the actual receipt time and retains old inputs.
    last = 0
    covered = start
    for period in periods:
        begin, end = period.get('from'), period.get('to')
        if (type(begin) is not int or type(end) is not int or begin <= 0
                or begin >= end or begin < last):
            raise ValueError('模拟天气预报时段须有效、有序且不重叠')
        last = end
        if begin <= covered < end:
            covered = end
    if covered < finish:
        raise ValueError('配置的模拟预报未完整覆盖任务飞行时段，请调整预报时段')
    published = min(created_at, periods[0]['from'])
    if last - published > 7 * 86400000:
        raise ValueError('模拟预报时段超出发布时间后七天')
    body = {'plan_id': plan_id, 'area_name': plan.get('district_name') or weather.get('area_name') or '模拟预报区域',
            'published_at': published, 'periods': periods}
    # Stable for retries; changed batch, plan or weather gets its own message, never rewrites history.
    digest = hashlib.sha256(json.dumps([batch, body], ensure_ascii=False, sort_keys=True,
                                      separators=(',', ':')).encode('utf-8')).hexdigest()[:40]
    return dict(body, message_id='sim-plan-weather-' + digest)
