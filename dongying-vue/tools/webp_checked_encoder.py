"""QA-tested ctypes WebP encoder: explicit ABI, decoded alpha/error guard, lossless fallback.

The structure definitions match the installed libwebp encode.h ABI 0x0210.
Near-lossless needs exact=0; transparent RGB may be discarded, but alpha is checked.
This module writes nothing by itself. encode_checked returns (bytes, audit_metadata).
"""
from pathlib import Path
import ctypes as C
import os
import sys
from io import BytesIO
import numpy as np
from PIL import Image

ABI = 0x0210
class Config(C.Structure):
    _fields_ = [(n, C.c_float if n in ('quality', 'target_PSNR') else C.c_int)
                for n in 'lossless quality method image_hint target_size target_PSNR segments sns_strength filter_strength filter_sharpness filter_type autofilter alpha_compression alpha_filtering alpha_quality pass show_compressed preprocessing partitions partition_limit emulate_jpeg_size thread_level low_memory near_lossless exact use_delta_palette use_sharp_yuv qmin qmax'.split()]
class Picture(C.Structure):
    _fields_ = [('use_argb',C.c_int),('colorspace',C.c_int),('width',C.c_int),('height',C.c_int),('y',C.c_void_p),('u',C.c_void_p),('v',C.c_void_p),('y_stride',C.c_int),('uv_stride',C.c_int),('a',C.c_void_p),('a_stride',C.c_int),('pad1',C.c_uint32*2),('argb',C.c_void_p),('argb_stride',C.c_int),('pad2',C.c_uint32*3),('writer',C.c_void_p),('custom_ptr',C.c_void_p),('extra_info_type',C.c_int),('extra_info',C.c_void_p),('stats',C.c_void_p),('error_code',C.c_int),('progress_hook',C.c_void_p),('user_data',C.c_void_p),('pad3',C.c_uint32*3),('pad4',C.c_void_p),('pad5',C.c_void_p),('pad6',C.c_uint32*8),('memory_',C.c_void_p),('memory_argb_',C.c_void_p),('pad7',C.c_void_p*2)]
class Writer(C.Structure):
    _fields_ = [('mem',C.c_void_p),('size',C.c_size_t),('max_size',C.c_size_t),('pad',C.c_uint32*1)]

class WebpEncoder:
    def __init__(self, library=None):
        self.path = Path(library) if library is not None else Path(sys.prefix) / 'Library/bin/libwebp.dll'
        if not self.path.is_file():
            raise FileNotFoundError(f'libwebp must be available in the GDAL environment: {self.path}')
        self._dll_directory = os.add_dll_directory(str(self.path.parent)) if os.name == 'nt' else None
        self.lib = lib = C.CDLL(str(self.path))
        for name, args, result in [
            ('WebPConfigInitInternal',[C.POINTER(Config),C.c_int,C.c_float,C.c_int],C.c_int),
            ('WebPPictureInitInternal',[C.POINTER(Picture),C.c_int],C.c_int),
            ('WebPPictureImportRGBA',[C.POINTER(Picture),C.c_void_p,C.c_int],C.c_int),
            ('WebPValidateConfig',[C.POINTER(Config)],C.c_int),
            ('WebPEncode',[C.POINTER(Config),C.POINTER(Picture)],C.c_int),
            ('WebPMemoryWriterInit',[C.POINTER(Writer)],None),
            ('WebPMemoryWriterClear',[C.POINTER(Writer)],None),
            ('WebPPictureFree',[C.POINTER(Picture)],None),
            ('WebPGetEncoderVersion',[],C.c_int),
        ]:
            fn = getattr(lib,name); fn.argtypes=args; fn.restype=result
        config, picture = Config(), Picture()
        if not lib.WebPConfigInitInternal(C.byref(config),0,75,ABI) or not lib.WebPPictureInitInternal(C.byref(picture),ABI):
            raise RuntimeError(f'libwebp encoder ABI mismatch: expected {ABI:#06x}')
        v=lib.WebPGetEncoderVersion()
        self.version=f'{v >> 16}.{(v >> 8) & 255}.{v & 255}'

    def _encode(self, array, near_lossless, method, exact):
        h,w,_=array.shape
        config,picture,writer=Config(),Picture(),Writer()
        if not self.lib.WebPConfigInitInternal(C.byref(config),0,75,ABI) or not self.lib.WebPPictureInitInternal(C.byref(picture),ABI):
            raise RuntimeError('libwebp initialization failed after ABI check')
        config.lossless=1; config.method=method; config.near_lossless=near_lossless
        config.exact=int(exact); config.alpha_quality=100
        if not self.lib.WebPValidateConfig(C.byref(config)):
            raise ValueError('libwebp rejected encoder configuration')
        picture.use_argb=1; picture.width=w; picture.height=h
        self.lib.WebPMemoryWriterInit(C.byref(writer))
        picture.writer=C.cast(self.lib.WebPMemoryWrite,C.c_void_p).value
        picture.custom_ptr=C.cast(C.byref(writer),C.c_void_p).value
        try:
            if not self.lib.WebPPictureImportRGBA(C.byref(picture),array.ctypes.data,w*4):
                raise RuntimeError('libwebp could not import RGBA')
            if not self.lib.WebPEncode(C.byref(config),C.byref(picture)):
                raise RuntimeError(f'libwebp encoding failed, error code {picture.error_code}')
            if not writer.mem or writer.size < 26:
                raise RuntimeError('libwebp returned empty or truncated image')
            return C.string_at(writer.mem,writer.size)
        finally:
            self.lib.WebPPictureFree(C.byref(picture))
            self.lib.WebPMemoryWriterClear(C.byref(writer))

    @staticmethod
    def _check(data, original):
        with Image.open(BytesIO(data)) as image:
            if image.format != 'WEBP' or image.size != (original.shape[1],original.shape[0]):
                raise RuntimeError('Encoded image has an unexpected format or dimensions')
            image.load()
            decoded=np.asarray(image.convert('RGBA'))
        visible=original[:,:,3]>0
        delta=np.abs(decoded[:,:,:3].astype(np.int16)-original[:,:,:3].astype(np.int16))
        return {'alpha_unchanged':bool(np.array_equal(decoded[:,:,3],original[:,:,3])),
                'max_visible_rgb_error':int(delta[visible].max()) if visible.any() else 0,
                'mean_visible_rgb_error':float(delta[visible].mean()) if visible.any() else 0.0}

    def encode_checked(self, rgba, near_lossless=60, method=4):
        if not isinstance(rgba,np.ndarray) or rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
            raise TypeError('Expected a uint8 HxWx4 RGBA array; implicit conversions are refused')
        if not (0<rgba.shape[0]<=16383 and 0<rgba.shape[1]<=16383):
            raise ValueError('Invalid WebP dimensions')
        if type(near_lossless) is not int or not 0<=near_lossless<=100 or type(method) is not int or not 0<=method<=6:
            raise ValueError('near_lossless must be 0..100 and method 0..6')
        array=np.ascontiguousarray(rgba)
        bound=0 if near_lossless==100 else 1 << max(0,(100-near_lossless)//20-1)
        encoded=self._encode(array,near_lossless,method,exact=near_lossless==100)
        audit=self._check(encoded,array)
        fallback=not audit['alpha_unchanged'] or audit['max_visible_rgb_error']>bound
        if fallback:
            encoded=self._encode(array,100,method,exact=True)
            audit=self._check(encoded,array)
            if not audit['alpha_unchanged'] or audit['max_visible_rgb_error'] != 0:
                raise RuntimeError('Even the exact lossless fallback failed decoded-pixel verification')
        audit.update({'bytes':len(encoded),'libwebp_version':self.version,'abi':ABI,
                      'requested_near_lossless':near_lossless,'actual_near_lossless':100 if fallback else near_lossless,
                      'lossless_fallback':fallback,'visible_rgb_error_limit':bound,
                      'transparent_rgb':'may be discarded in near-lossless; invisible only'})
        return encoded,audit
