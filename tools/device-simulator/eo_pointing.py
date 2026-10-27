"""Explicit QA gimbal: true-north degrees, rate-limited simulated mechanics.

Static coverage is a separate installation constraint, never the camera's FOV.
Recorded video is a labelled replay; this model does not claim geographic pixels.
"""
import math


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def delta(a, b):
    return (a - b + 180) % 360 - 180


class SimulatedGimbal:
    PAN_RATE = 30.0
    TILT_RATE = 15.0
    HFOV, VFOV = 12.0, 8.0

    def __init__(self, binding, now):
        self.binding = binding
        self.pan = (binding.get('coverage') or {}).get('azimuthDeg', 0)
        self.tilt = 0.0
        self.updated = now
        self.state = 'IDLE'

    def begin(self, now):
        self.updated, self.state = now, 'TURNING'

    def camera(self, now):
        return {'panOrientAngle': self.pan, 'tiltOrientAngle': self.tilt,
                'hfov': self.HFOV, 'vfov': self.VFOV, 'angleReference': 'TRUE_NORTH',
                'angleUnit': 'DEG', 'calibrated': True, 'simulated': True,
                'observedAt': int(now * 1000), 'trackingState': self.state}

    def update(self, sample, detail, now):
        dt = 0 if self.state in ('UNKNOWN', 'LOST') else max(0, now - self.updated)
        self.updated = now
        if not sample:
            self.state = 'UNKNOWN'
            return False
        measured = detail.get('latest_state') or {}
        stamp = measured.get('observed_at')
        guide = measured.get('location') or {}
        guide_lon, guide_lat, guide_height = guide.get('longitude'), guide.get('latitude'), measured.get('altitude_amsl_m')
        coordinates = [self.binding.get('longitude'), self.binding.get('latitude'),
                       sample.get('longitude'), sample.get('latitude'),
                       sample.get('altitude'), self.binding.get('altitude_m')]
        if (not all(finite(v) for v in coordinates) or not finite(stamp)
                or not 0 <= now * 1000 - stamp <= 15000
                or sample.get('coordinate_system') not in ('WGS84', 'WGS-84')
                or sample.get('altitude_datum') != 'AMSL'
                or self.binding.get('altitude_datum') != 'AMSL'
                or not all(finite(v) for v in (guide_lon, guide_lat, guide_height))
                or guide.get('coordinate_system') not in ('WGS84', 'WGS-84')
                or measured.get('point_kind', 'MEAS') != 'MEAS'
                or measured.get('status') in ('UNKNOWN', 'PREDICTED', 'EXPIRED')
                or detail.get('source_mode') not in ('replay', None)):
            self.state = 'UNKNOWN'
            return False
        lon, lat, target_lon, target_lat, height, base = coordinates
        if not (-180 <= lon <= 180 and -90 <= lat <= 90 and -180 <= target_lon <= 180 and -90 <= target_lat <= 90):
            self.state = 'UNKNOWN'
            return False
        if not (-180 <= guide_lon <= 180 and -90 <= guide_lat <= 90):
            self.state = 'UNKNOWN'
            return False
        def geometry(target_lon, target_lat, height):
            p1, p2, dl = math.radians(lat), math.radians(target_lat), math.radians(target_lon - lon)
            y = math.sin(dl) * math.cos(p2)
            x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
            bearing = math.degrees(math.atan2(y, x)) % 360
            a = math.sin((p2-p1)/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
            distance = 6371000 * 2 * math.atan2(math.sqrt(min(1,a)), math.sqrt(max(0,1-a)))
            return bearing, math.degrees(math.atan2(height-base, distance)), distance
        # The platform's latest measured position guides the slew. The scene's
        # independently source-linked current sample determines actual capture.
        bearing, elevation, distance = geometry(target_lon, target_lat, height)
        guide_bearing, guide_elevation, _ = geometry(guide_lon, guide_lat, guide_height)
        coverage = self.binding.get('coverage') or {}
        radius = coverage.get('radiusM') if coverage.get('kind') == 'circle' else coverage.get('rangeM')
        in_coverage = finite(radius) and distance <= radius
        if coverage.get('kind') == 'sector':
            center, angle = coverage.get('azimuthDeg'), coverage.get('fovDeg')
            in_coverage = in_coverage and finite(center) and finite(angle) and abs(delta(bearing, center)) <= angle/2
        elif coverage.get('kind') != 'circle':
            in_coverage = False
        if not in_coverage:
            self.state = 'LOST'
            return False
        # Once captured, the camera's own video tracker holds the lock and steers by
        # what it sees; the platform's ~1 s old fused guide only drives acquisition.
        # Otherwise a close fast pass drifts out of the 6° half-FOV and flickers TURNING.
        locked = self.state == 'TRACKING'
        aim_bearing, aim_elevation = (bearing, elevation) if locked else (guide_bearing, guide_elevation)
        dp, de = delta(aim_bearing, self.pan), aim_elevation-self.tilt
        self.pan = (self.pan + max(-self.PAN_RATE*dt, min(self.PAN_RATE*dt, dp))) % 360
        self.tilt += max(-self.TILT_RATE*dt, min(self.TILT_RATE*dt, de))
        captured = abs(delta(bearing, self.pan)) <= self.HFOV/2 and abs(elevation-self.tilt) <= self.VFOV/2
        # A command acknowledgment cannot itself be capture, even at the initial pose.
        self.state = 'TRACKING' if captured and dt > 0 else 'TURNING'
        return self.state == 'TRACKING'
