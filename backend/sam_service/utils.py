from typing import List, Tuple
import base64
import io
from PIL import Image
import numpy as np


def decode_base64_image(data_url: str) -> Image.Image:
    # Accept either data URLs (data:image/png;base64,...) or raw base64
    if data_url.startswith('data:'):
        header, b64 = data_url.split(',', 1)
    else:
        b64 = data_url
    data = base64.b64decode(b64)
    return Image.open(io.BytesIO(data)).convert('RGBA')


def encode_image_to_dataurl(img: Image.Image, fmt='PNG') -> str:
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return f"data:image/{fmt.lower()};base64,{b64}"


def mask_to_polygons(mask_np: np.ndarray) -> List[List[Tuple[int,int]]]:
    # mask_np should be HxW binary (0/255)
    import cv2
    contours, _ = cv2.findContours(mask_np.astype('uint8'), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    for cnt in contours:
        # simplify and convert to list of (x,y)
        approx = cv2.approxPolyDP(cnt, epsilon=2.0, closed=True)
        poly = [(int(p[0][0]), int(p[0][1])) for p in approx]
        if len(poly) >= 3:
            polys.append(poly)
    return polys
