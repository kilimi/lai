/**
 * Helpers for evaluation prediction snapshot thumbnails (bbox parsing, crop, canvas draw).
 */

/** Minimum box extent used when computing padding so division stays stable. */
export const EVAL_PREDICTION_MIN_BOX_EPS = 1e-6;

/** Default relative padding around bbox for snapshot context (~22%). */
export const EVAL_PREDICTION_DEFAULT_PAD_FRAC = 0.22;

export type PredictionBBoxSource = {
  bbox_xyxy?: unknown;
  bbox?: unknown;
};

function fourFiniteNumbers(arr: unknown): [number, number, number, number] | null {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const a = Number(arr[0]);
  const b = Number(arr[1]);
  const c = Number(arr[2]);
  const d = Number(arr[3]);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  return [a, b, c, d];
}

/**
 * Parse prediction bbox as xyxy in pixel space.
 * Supports `bbox_xyxy` or COCO-style `bbox` [x, y, w, h].
 * Normalizes inverted corners; rejects NaN/Infinity and zero-area boxes.
 */
export function getPredictionBboxXyxy(pred: PredictionBBoxSource): [number, number, number, number] | null {
  const xyxyRaw = fourFiniteNumbers(pred.bbox_xyxy);
  if (xyxyRaw) {
    const [p0, p1, p2, p3] = xyxyRaw;
    const x1 = Math.min(p0, p2);
    const x2 = Math.max(p0, p2);
    const y1 = Math.min(p1, p3);
    const y2 = Math.max(p1, p3);
    if (x2 <= x1 || y2 <= y1) return null;
    return [x1, y1, x2, y2];
  }
  const bb = fourFiniteNumbers(pred.bbox);
  if (bb) {
    const [x, y, w, h] = bb;
    const x1 = Math.min(x, x + w);
    const x2 = Math.max(x, x + w);
    const y1 = Math.min(y, y + h);
    const y2 = Math.max(y, y + h);
    if (x2 <= x1 || y2 <= y1) return null;
    return [x1, y1, x2, y2];
  }
  return null;
}

/** Expand bbox by padFrac of box size for context; clamp to image bounds. */
export function paddedCropRegion(
  [x1, y1, x2, y2]: [number, number, number, number],
  nw: number,
  nh: number,
  padFrac: number = EVAL_PREDICTION_DEFAULT_PAD_FRAC
): { sx: number; sy: number; sw: number; sh: number } {
  const bw = Math.max(EVAL_PREDICTION_MIN_BOX_EPS, x2 - x1);
  const bh = Math.max(EVAL_PREDICTION_MIN_BOX_EPS, y2 - y1);
  const padX = bw * padFrac;
  const padY = bh * padFrac;
  let sx = x1 - padX;
  let sy = y1 - padY;
  let sw = bw + 2 * padX;
  let sh = bh + 2 * padY;
  if (sx < 0) {
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    sh += sy;
    sy = 0;
  }
  if (sx + sw > nw) sw = nw - sx;
  if (sy + sh > nh) sh = nh - sy;
  sw = Math.max(1, sw);
  sh = Math.max(1, sh);
  return { sx, sy, sw, sh };
}

/** Draw cropped region around bbox (natural pixels) scaled to cw×ch like object-contain, then bbox + label. */
export function drawPredictionSnapshotCrop(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  bbox: [number, number, number, number],
  label: string,
  cw: number,
  ch: number
): void {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh || !cw || !ch) return;

  const { sx, sy, sw, sh } = paddedCropRegion(bbox, nw, nh);
  const scale = Math.min(cw / sw, ch / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;

  const [x1, y1, x2, y2] = bbox;
  const mapX = (x: number) => ox + (x - sx) * scale;
  const mapY = (y: number) => oy + (y - sy) * scale;
  let px1 = mapX(x1);
  let py1 = mapY(y1);
  let px2 = mapX(x2);
  let py2 = mapY(y2);
  const rx1 = Math.min(px1, px2);
  const ry1 = Math.min(py1, py2);
  const rx2 = Math.max(px1, px2);
  const ry2 = Math.max(py1, py2);
  px1 = rx1;
  py1 = ry1;
  px2 = rx2;
  py2 = ry2;

  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, ox, oy, dw, dh);

  const lineW = Math.max(2, Math.round(Math.min(cw, ch) / 90));
  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = lineW;
  ctx.strokeRect(px1, py1, px2 - px1, py2 - py1);

  const fontPx = Math.max(11, Math.round(Math.min(cw, ch) / 28));
  ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const pad = 4;
  const textW = ctx.measureText(label).width;
  const labelH = fontPx + pad;
  let ly = py1 - labelH - 2;
  if (ly < oy + 2) ly = py1 + lineW + 2;
  ly = Math.max(oy + 2, Math.min(oy + dh - labelH - 2, ly));
  const lx = Math.max(ox + 2, Math.min(ox + dw - textW - pad * 2 - 2, px1));

  ctx.fillStyle = "rgba(34, 197, 94, 0.95)";
  ctx.fillRect(lx, ly, textW + pad * 2, labelH);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillText(label, lx + pad, ly + fontPx - 1);
}
