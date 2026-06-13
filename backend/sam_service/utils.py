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


def mask_binary_uint8(mask) -> np.ndarray:
    """Convert a SAM mask tensor/array to HxW uint8 {0,255}."""
    if hasattr(mask, "cpu"):
        mask = mask.cpu().numpy()
    mask = np.asarray(mask)
    mask = np.squeeze(mask)
    while mask.ndim > 2:
        mask = mask[0]
    return (mask > 0.5).astype(np.uint8) * 255


def iter_instance_masks(masks) -> List[np.ndarray]:
    """Split SAM3 state['masks'] (N,1,H,W) into per-instance HxW masks."""
    if masks is None:
        return []
    if hasattr(masks, "cpu"):
        masks = masks.cpu().numpy()
    masks = np.asarray(masks)
    if masks.size == 0:
        return []
    if masks.ndim >= 4:
        return [mask_binary_uint8(masks[i]) for i in range(masks.shape[0])]
    if masks.ndim == 3:
        return [mask_binary_uint8(masks[i]) for i in range(masks.shape[0])]
    return [mask_binary_uint8(masks)]


def polygons_from_instance_masks(
    masks,
    orig_w: int,
    orig_h: int,
) -> List[List[List[int]]]:
    """One or more polygons per detected instance; all instances included."""
    polys_out: List[List[List[int]]] = []
    for mask in iter_instance_masks(masks):
        if mask.shape[0] != orig_h or mask.shape[1] != orig_w:
            mask_pil = Image.fromarray(mask).resize((orig_w, orig_h), Image.NEAREST)
            mask = np.array(mask_pil)
        for poly in mask_to_polygons(mask):
            polys_out.append([[int(x), int(y)] for (x, y) in poly])
    return polys_out


def combine_instance_masks(masks, orig_w: int, orig_h: int) -> np.ndarray:
    """OR-merge instance masks for preview overlay."""
    combined = np.zeros((orig_h, orig_w), dtype=np.uint8)
    for mask in iter_instance_masks(masks):
        if mask.shape[0] != orig_h or mask.shape[1] != orig_w:
            mask_pil = Image.fromarray(mask).resize((orig_w, orig_h), Image.NEAREST)
            mask = np.array(mask_pil)
        combined = np.maximum(combined, mask)
    return combined

