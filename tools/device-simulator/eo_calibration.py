"""Geometry shared by the generated QA scene and its encoded-frame detections.

These are simulated calibration shapes, not detections over arbitrary footage.
Coordinates are native 960x540 encoded-frame pixels, before any viewer scaling.
"""
WIDTH, HEIGHT = 960, 540
FPS = 15
# Two rotors, arms and body form one deterministic drone-shaped calibration object.
PARTS = ((380, 230, 64, 20), (516, 230, 64, 20), (410, 250, 140, 12),
         (440, 258, 80, 36), (380, 294, 64, 16), (516, 294, 64, 16), (410, 282, 140, 12))
BBOX = (380, 230, 200, 80)


def scene_filters():
    shapes = [f'drawbox=x={x}:y={y}:w={w}:h={h}:color=0x3de3e0:t=fill' for x, y, w, h in PARTS]
    return ','.join(shapes) + ',' + barcode_filters()


def barcode_filters():
    # The calibration barcode is part of the actual rendered frame. A decoded
    # HLS fragment can prove exactly which generated frame its PDT belongs to.
    shapes = ['drawbox=x=16:y=516:w=8:h=8:color=0xff00ff:t=fill',
               'drawbox=x=320:y=516:w=8:h=8:color=0xff00ff:t=fill']
    shapes += [f"drawbox=x={32 + bit * 12}:y=516:w=8:h=8:color=white:t=fill:enable='mod(floor(n/{2 ** bit}),2)'"
               for bit in range(24)]
    return ','.join(shapes)


def decoded_frame_number(rgb):
    if len(rgb) != WIDTH * HEIGHT * 3:
        raise ValueError('校准视频解码尺寸不匹配')
    def pixel(x):
        offset = (520 * WIDTH + x) * 3
        return rgb[offset:offset + 3]
    for x in (20, 324):
        red, green, blue = pixel(x)
        if not (red > 170 and green < 100 and blue > 170):
            raise ValueError('校准视频帧标记缺失，不能建立时钟关联')
    result = 0
    for bit in range(24):
        red, green, blue = pixel(36 + bit * 12)
        if min(red, green, blue) > 170: result |= 1 << bit
        elif max(red, green, blue) > 120:
            raise ValueError('校准视频帧号无法可靠读取')
    return result


def detection(stream_id, association=None):
    x, y, width, height = BBOX
    value = {'detection_id': 'qa-shape-' + stream_id, 'x': x / WIDTH, 'y': y / HEIGHT,
             'width': width / WIDTH, 'height': height / HEIGHT, 'class_code': 'UAV', 'confidence': 1.0}
    if association:
        value['observation_id'] = association['observation_id']
    return value
