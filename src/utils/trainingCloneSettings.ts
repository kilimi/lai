/** Map stored model_type / model_variant strings to TrainModelModal modelSettings (YOLO). */
export function parseYoloPresetFromModelType(modelTypeRaw: string | undefined | null): {
  version: string;
  size: string;
  task: "detection" | "segmentation" | "classification";
  modelSize: string;
} | null {
  if (!modelTypeRaw || typeof modelTypeRaw !== "string") return null;
  const lower = modelTypeRaw.toLowerCase().replace(/\.pt$/i, "");
  if (lower.includes("rtdetr")) return null;

  let task: "detection" | "segmentation" | "classification" = "detection";
  let base = lower;
  if (base.endsWith("-seg")) {
    task = "segmentation";
    base = base.slice(0, -4);
  } else if (base.endsWith("-cls")) {
    task = "classification";
    base = base.slice(0, -4);
  }

  let version = "yolo11";
  let size = "n";

  const y26 = /^yolo26([nsmlx])/i.exec(base);
  if (y26) {
    version = "yolo26";
    size = y26[1].toLowerCase();
    return { version, size, task, modelSize: buildYoloModelSize(version, size, task) };
  }

  const nas = /^yolo_?nas_?([smlx])/i.exec(base) ?? /^yolonas([smlx])/i.exec(base);
  if (nas) {
    version = "yolo_nas";
    size = nas[1].toLowerCase();
    return { version, size, task, modelSize: buildYoloModelSize(version, size, task) };
  }

  const ym = /^yolov?(\d+)([nsmlx])(?:[-._]|$)/i.exec(base);
  if (ym && ym[2]) {
    const num = parseInt(ym[1], 10);
    // v8 and below use "yolov{n}" prefix; v11+ use "yolo{n}" (no "v")
    version = num >= 10 ? `yolo${num}` : `yolov${num}`;
    size = ym[2].toLowerCase();
    return { version, size, task, modelSize: buildYoloModelSize(version, size, task) };
  }

  return { version, size, task, modelSize: buildYoloModelSize(version, size, task) };
}

export function buildYoloModelSize(
  version: string,
  size: string,
  task: "detection" | "segmentation" | "classification"
): string {
  const normalizedVersion = (version || "").toLowerCase();
  const normalizedSize = (size || "n").toLowerCase();
  let name = normalizedVersion === "yolo_nas"
    ? `yolo_nas_${normalizedSize}`
    : `${normalizedVersion}${normalizedSize}`;
  if (task === "segmentation") name += "-seg";
  else if (task === "classification") name += "-cls";
  return `${name}.pt`;
}

/** RF-DETR variant key used in TrainModelModal (no .pt). */
export function rtdetrVariantFromStored(raw: string | undefined | null): string {
  if (!raw || typeof raw !== "string") return "rtdetr-l";
  const s = raw.replace(/\.pt$/i, "").toLowerCase();
  if (s.includes("rtdetr-x") || s === "rtdetrx") return "rtdetr-x";
  return "rtdetr-l";
}
