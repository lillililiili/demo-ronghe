"""Opt-in replay AI samples from the scene entity, never platform fused coordinates."""
import math
from engine import target_sample


class EoObservations:
    def __init__(self, config, manifest, targets, elapsed):
        self.config, self.manifest, self.targets, self.elapsed = config or {}, manifest, targets, elapsed
        if 'enabled' in self.config and type(self.config['enabled']) is not bool:
            raise ValueError('EO AI enabled must be boolean')
        interval = self.config.get('intervalSeconds', 2)
        if type(interval) not in (int, float) or not math.isfinite(interval) or not 0.1 <= interval <= 300:
            raise ValueError('EO AI intervalSeconds must be a finite number from 0.1 to 300')

    def observation(self, detail, binding):
        if self.config.get('enabled') is not True or not self.manifest.get('batch'):
            return None
        elapsed = self.elapsed()
        if any(w['at'] <= elapsed < w['at'] + w['seconds'] for w in self.config.get('silenceWindows', [])):
            return None
        candidates = set()
        for identity, target in self.targets.items():
            allocated = self.manifest.get('targets', {}).get(identity, {})
            external = allocated.get('mqtt_object_id')
            if target.get('transport') == 'normalized':
                # The optional secondary sensor may really report protocol A for this same scene entity.
                # Only its allocated MQTT id and registered device can prove the mapping; the normalized
                # primary's separate source id, fused location and display name cannot establish it.
                device_keys = () if target.get('secondaryTransport') == 'normalized' else (target.get('secondaryDeviceId'),)
            else:
                device_keys = (target.get('deviceId'), target.get('secondaryDeviceId'))
            for device_key in device_keys:
                device = self.manifest.get('devices', {}).get(device_key, {})
                device_ids = {device.get('platform_id'), device.get('fusion_device_id')}-{None}
                # The registered device's source_id is the operations-layer source; source_links carry the fusion-layer
                # source. They are two ids by design, so the link is matched by the fusion device the backend already
                # bound to that source (a link whose device belongs to another source is never returned).
                if external is not None and any(link.get('device_id') in device_ids
                        and str(link.get('external_target_id')) == str(external)
                        and str(link.get('source_mode', '')).lower() == 'replay'
                        for link in detail.get('source_links', [])):
                    candidates.add(identity)
        if len(candidates) != 1:
            return None
        target = self.targets[next(iter(candidates))]
        category = {'uav':'drone', 'bird':'bird'}.get(target.get('kind'))
        if category is None:
            return None
        quality = [self.config.get('detectConfidence'), self.config.get('trackConfidence')]
        if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in quality):
            return None
        sample = target_sample(target, elapsed)
        lon, lat = sample['longitude'], sample['latitude']
        if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
            return None
        result = {'className':category,'longitude':lon,'latitude':lat,
                  'detectConfidence':quality[0],'trackConfidence':quality[1]}
        if target.get('altitudeDatum') == 'ELLIPSOID' and math.isfinite(sample['altitude']):
            result['altitude'] = sample['altitude']
        for window in self.config.get('anomalyWindows', []):
            if not window['at'] <= elapsed < window['at'] + window['seconds']: continue
            kind = window['kind']
            if kind == 'missing_position':
                result.pop('longitude', None); result.pop('latitude', None)
            elif kind == 'missing_confidence': result.pop('detectConfidence', None)
            elif kind == 'class_conflict': result['className'] = 'bird' if category == 'drone' else 'drone'
            elif kind == 'position_jump': result['longitude'] = min(180, lon + .1)
        return result
