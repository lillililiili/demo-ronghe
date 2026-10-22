"""CC0 recorded fixture: annotations describe footage pixels, never live detections."""
import hashlib
import json
import math
from pathlib import Path
from eo_calibration import WIDTH, HEIGHT, FPS, barcode_filters


class RecordedClip:
    def __init__(self, manifest):
        manifest = Path(manifest)
        data = json.loads(manifest.read_text(encoding='utf-8'))
        name = data.get('video', '')
        if not isinstance(name, str) or not name or Path(name).name != name or '/' in name or '\\' in name:
            raise ValueError('实拍素材路径无效')
        self.path = manifest.parent / name
        if not self.path.is_file() or hashlib.sha256(self.path.read_bytes()).hexdigest() != data.get('sha256'):
            raise ValueError('实拍素材与逐帧标注的校验值不匹配')
        if (data.get('width'), data.get('height'), data.get('fps')) != (640, 512, 30):
            raise ValueError('实拍素材尺寸或帧率不支持')
        count = data.get('frame_count')
        boxes = data.get('boxes')
        if type(count) is not int or count <= 0 or count % 2 or not isinstance(boxes, list) or len(boxes) != count:
            raise ValueError('实拍素材帧数与标注不匹配')
        for box in boxes:
            if box is None: continue
            if (not isinstance(box, list) or len(box) != 4
                or not all(type(v) in (int, float) and math.isfinite(v) for v in box)
                or box[0] < 0 or box[1] < 0 or box[2] <= 0 or box[3] <= 0
                or box[0] + box[2] > 640 or box[1] + box[3] > 512):
                raise ValueError('实拍素材标注越界或无效')
        # Select even source frames explicitly, avoiding fps-filter rounding.
        self.boxes = boxes[::2]
        self.frame_count = count // 2

    def box(self, frame, offset=0):
        if type(frame) is not int or frame < 0 or type(offset) is not int or offset < 0:
            raise ValueError('实拍帧号无效')
        box = self.boxes[(frame + offset) % self.frame_count]
        return (box[0] + 160, box[1], box[2], box[3]) if box is not None else None

    def filters(self, kind, offset=0):
        if kind not in ('RAW', 'AI') or type(offset) is not int or not 0 <= offset < self.frame_count:
            raise ValueError('实拍视频类型或起始帧无效')
        result = ["select='not(mod(n,2))'", f'trim=start_frame={offset}',
                  f'setpts=N/({FPS}*TB)', 'pad=960:540:160:0:color=black', 'setsar=1']
        if kind == 'AI':
            for frame in range(self.frame_count):
                box = self.box(frame)
                if box is None: continue
                x, y, w, h = box
                result.append(f"drawbox=x={x:.3f}:y={y:.3f}:w={w:.3f}:h={h:.3f}:color=0x3de3e0:t=1:enable='eq(mod(n+{offset},{self.frame_count}),{frame})'")
        result.append(barcode_filters())
        return ','.join(result)

    def detection(self, stream_id, frame, association=None, offset=0):
        box = self.box(frame, offset)
        if box is None: return None
        x, y, w, h = box
        value = {'detection_id': 'qa-recorded-' + stream_id, 'x': x / WIDTH, 'y': y / HEIGHT,
                 'width': w / WIDTH, 'height': h / HEIGHT, 'class_code': 'UAV'}
        if association: value['observation_id'] = association['observation_id']
        return value


def recorded_clip():
    return RecordedClip(Path(__file__).parent / 'assets' / 'eo-visible' / 'annotations.json')
