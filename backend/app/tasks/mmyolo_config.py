"""MMYOLO training config generation."""
from dataclasses import dataclass
from pathlib import Path

from typing import List

from app.ml.mmyolo_catalog import (
    MMYOLO_OFFICIAL_CONFIG_STEMS,
    resolve_mmyolo_pretrained_local_path,
)


_MMYOLO_CONFIG_ROOTS = (
    Path("/opt/mmyolo/configs"),
    Path("/app/models/mmyolo"),
)


def _mmyolo_config_search_roots() -> List[Path]:
    roots: List[Path] = [p for p in _MMYOLO_CONFIG_ROOTS if p.is_dir()]
    try:
        import mmdet

        mmdet_root = Path(mmdet.__file__).resolve().parent
        for sub in (".mim/configs", "configs"):
            candidate = mmdet_root / sub
            if candidate.is_dir():
                roots.append(candidate)
    except Exception:
        pass
    return roots


def _normalize_config_stem(config_id: str) -> str:
    cfg = (config_id or "").strip().replace("\\", "/")
    if not cfg:
        return MMYOLO_OFFICIAL_CONFIG_STEMS["rtmdet_s"]
    stem = Path(cfg).stem if cfg.endswith(".py") else cfg.split("/")[-1]
    return MMYOLO_OFFICIAL_CONFIG_STEMS.get(stem, stem)


def resolve_mmyolo_base_config(config_id: str, *, dji_repo_dir: str | Path | None = None) -> str:
    """
    Resolve a MMYOLO config id to an absolute config file path.

    DJI mode must use configs from the patched clone (not /opt/mmyolo), because the
    AI Inside patch modifies training/export code in that repo.
    """
    if dji_repo_dir:
        from app.tasks.mmyolo_dji import resolve_dji_base_config

        return resolve_dji_base_config(Path(dji_repo_dir), config_id)
    cfg = (config_id or "").strip()
    if not cfg:
        cfg = "rtmdet_s"

    direct = Path(cfg)
    if direct.is_file():
        return str(direct.resolve())

    stem = _normalize_config_stem(cfg)
    filename = f"{stem}.py"

    for root in _mmyolo_config_search_roots():
        exact = root / filename
        if exact.is_file():
            return str(exact.resolve())
        matches = sorted(root.glob(f"**/{filename}"))
        if matches:
            return str(matches[0].resolve())

    searched = ", ".join(str(r) for r in _mmyolo_config_search_roots()) or "(no config roots found)"
    raise FileNotFoundError(
        f"MMYOLO base config not found for {config_id!r} (stem={stem!r}). "
        f"Searched: {searched}. "
        "Ensure mmyolo/mmdet are installed in the worker image or run mim download for this variant."
    )


def mmyolo_cfg_options_list(*, batch_size: int, epochs: int) -> List[str]:
    """mim --cfg-options entries (each must be a separate argv token)."""
    val_interval = max(1, min(10, max(1, epochs // 3)))
    return [
        f"train_dataloader.batch_size={batch_size}",
        f"train_cfg.max_epochs={epochs}",
        f"train_cfg.val_interval={val_interval}",
        f"default_hooks.param_scheduler.max_epochs={epochs}",
        f"default_hooks.checkpoint.interval={val_interval}",
    ]


def _is_rotated_arch(arch: str) -> bool:
    return (arch or "").strip() == "rtmdet-r"


def build_model_override(
    num_classes: int,
    *,
    is_dji_mode: bool,
    dji_use_widen_factor_025: bool,
) -> str:
    """Build the model override block for generated MMYOLO configs."""
    assigner_override = f"""    train_cfg=dict(
        assigner=dict(
            num_classes={num_classes},
        ),
    ),"""

    if is_dji_mode and dji_use_widen_factor_025:
        return f"""
# Override model: widen_factor=0.25 required for DJI 4K quantization deployment
# in_channels/out_channels are base YOLOv8 values; widen_factor scales them at build time
model = dict(
    backbone=dict(
        widen_factor=0.25,
    ),
    neck=dict(
        widen_factor=0.25,
        in_channels=[256, 512, 1024],
        out_channels=[256, 512, 1024],
    ),
    bbox_head=dict(
        head_module=dict(
            widen_factor=0.25,
            num_classes={num_classes},
        ),
    ),
{assigner_override}
)
"""

    comment = (
        "# DJI mode without widen_factor override (default YOLOv8-S widen_factor=0.5)"
        if is_dji_mode
        else "# Override num_classes in model head and assigner (base COCO config uses 80)"
    )
    return f"""
{comment}
model = dict(
    bbox_head=dict(
        head_module=dict(
            num_classes={num_classes},
        ),
    ),
{assigner_override}
)
"""


@dataclass(frozen=True)
class MMYOLOConfigParams:
    base_cfg: str
    num_classes: int
    class_names_py: str
    epochs: int
    batch_size: int
    image_size: int
    work_dir: str
    train_json_abs: str
    val_json_abs: str
    train_images_abs: str
    val_images_abs: str
    is_dji_mode: bool
    dji_use_widen_factor_025: bool
    arch: str = "rtmdet"


def resolve_mmyolo_split_paths(dataset_info: dict, dataset_dir: Path) -> tuple[str, str, str, str]:
    """
    Resolve train/val annotation and image directory paths.

    When no val split exists (common with tiny datasets), validation reuses the
    train annotations and image directory so MMYOLO does not look for files under
    an empty images/val/ folder.
    """
    train_json_abs = str(Path(dataset_info["train_json"]).absolute())
    train_images_abs = str((dataset_dir / "images" / "train").absolute())

    val_count = dataset_info.get("image_counts", {}).get("val", 0)
    val_json = dataset_info.get("val_json")
    if val_json and val_count > 0:
        val_json_abs = str(Path(val_json).absolute())
        val_images_abs = str((dataset_dir / "images" / "val").absolute())
    else:
        val_json_abs = train_json_abs
        val_images_abs = train_images_abs

    return train_json_abs, train_images_abs, val_json_abs, val_images_abs


def build_mmyolo_load_from_line(
    base_cfg: str,
    *,
    is_dji_mode: bool,
    dji_use_widen_factor_025: bool,
) -> str:
    """
    Build the load_from assignment for generated MMYOLO configs.

    Training must never point at OpenMMLab URLs — only weights from
    `lai download-models` under /app/models/mmyolo are used at runtime.
    """
    skip_pretrained = is_dji_mode and dji_use_widen_factor_025
    if skip_pretrained:
        return (
            "load_from = None  # DJI widen_factor=0.25 — standard YOLOv8-S checkpoint "
            "uses widen_factor=0.5 and is incompatible"
        )

    local_pretrained = resolve_mmyolo_pretrained_local_path(base_cfg)
    if local_pretrained:
        return f"load_from = '{local_pretrained}'"

    return (
        "# load_from not set — run `lai download-models --mmyolo yolov8_s` "
        "(or the matching alias) to cache pretrained weights under /app/models/mmyolo"
    )


def _build_custom_imports_line(*, is_rotated: bool) -> str:
    imports = ["mmdet.evaluation.metrics.coco_metric"]
    if is_rotated:
        imports.append("mmrotate")
    return f"custom_imports = dict(imports={imports!r}, allow_failed_imports=False)"


def _build_pipeline_block(*, image_size: int, is_rotated: bool) -> str:
    if is_rotated:
        return f"""# COCO polygons → rotated boxes (mmrotate dota_coco pattern).
_pad_resize_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='LoadAnnotations', with_bbox=True, with_mask=True, poly2mask=False),
    dict(type='ConvertMask2BoxType', box_type='rbox'),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='Pad', size_divisor=32),
    dict(type='RandomFlip', prob=0.5),
    dict(
        type='PackDetInputs',
        meta_keys=('img_id', 'img_path', 'ori_shape', 'img_shape', 'scale_factor'),
    ),
]
train_pipeline = list(_pad_resize_pipeline)
train_pipeline_stage2 = list(_pad_resize_pipeline)
test_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='Pad', size_divisor=32),
    dict(type='LoadAnnotations', with_bbox=True, with_mask=True, poly2mask=False),
    dict(type='ConvertMask2BoxType', box_type='qbox'),
    dict(
        type='PackDetInputs',
        meta_keys=('img_id', 'img_path', 'ori_shape', 'img_shape', 'scale_factor'),
    ),
]"""
    return f"""# Simple pipelines without Mosaic/Albu — the base YOLOv8 config uses albumentations in
# train_pipeline_stage2 (via PipelineSwitchHook) which requires img_path and breaks
# with our absolute-path COCO setup. Reuse the same safe pipeline for stage-2 as well.
_pad_resize_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='LoadAnnotations', with_bbox=True),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='Pad', size_divisor=32),
    dict(type='RandomFlip', prob=0.5),
    dict(
        type='PackDetInputs',
        meta_keys=('img_id', 'img_path', 'ori_shape', 'img_shape', 'scale_factor'),
    ),
]
train_pipeline = list(_pad_resize_pipeline)
train_pipeline_stage2 = list(_pad_resize_pipeline)
test_pipeline = [
    dict(type='LoadImageFromFile', backend_args=None),
    dict(type='Resize', scale=({image_size}, {image_size}), keep_ratio=True),
    dict(type='Pad', size_divisor=32),
    dict(type='LoadAnnotations', with_bbox=True),
    dict(type='PackDetInputs', meta_keys=('img_id', 'img_path', 'ori_shape', 'img_shape', 'scale_factor')),
]"""


def _build_dataloader_block(params: MMYOLOConfigParams, *, is_rotated: bool) -> str:
    dataset_type_line = "        type='mmdet.CocoDataset',\n" if is_rotated else ""
    return f"""train_dataloader = dict(
    batch_size={params.batch_size},
    num_workers=4,
    dataset=dict(
{dataset_type_line}        data_root='',
        ann_file='{params.train_json_abs}',
        data_prefix=dict(img='{params.train_images_abs}/'),
        metainfo=dict(classes=_classes),
        pipeline=train_pipeline,
    ),
)
val_dataloader = dict(
    batch_size=1,
    num_workers=2,
    dataset=dict(
{dataset_type_line}        data_root='',
        ann_file='{params.val_json_abs}',
        data_prefix=dict(img='{params.val_images_abs}/'),
        metainfo=dict(classes=_classes),
        pipeline=test_pipeline,
    ),
)
test_dataloader = val_dataloader"""


def _build_evaluator_block(params: MMYOLOConfigParams, *, is_rotated: bool) -> str:
    if is_rotated:
        return f"""val_evaluator = dict(
    type='mmrotate.RotatedCocoMetric',
    ann_file='{params.val_json_abs}',
    metric='bbox',
    format_only=False,
)
test_evaluator = val_evaluator"""
    return f"""val_evaluator = dict(
    type='mmdet.CocoMetric',
    ann_file='{params.val_json_abs}',
    metric=['bbox'],
    format_only=False,
)
test_evaluator = val_evaluator"""


def build_mmyolo_config_content(params: MMYOLOConfigParams) -> str:
    """Generate the full mmyolo_config.py file content."""
    is_rotated = _is_rotated_arch(params.arch)
    model_override = build_model_override(
        params.num_classes,
        is_dji_mode=params.is_dji_mode,
        dji_use_widen_factor_025=params.dji_use_widen_factor_025,
    )
    image_size = params.image_size
    val_interval = max(1, min(10, max(1, params.epochs // 3)))
    load_from_line = build_mmyolo_load_from_line(
        params.base_cfg,
        is_dji_mode=params.is_dji_mode,
        dji_use_widen_factor_025=params.dji_use_widen_factor_025,
    )
    visualizer_line = (
        "visualizer = dict(type='mmrotate.RotLocalVisualizer')\n"
        if is_rotated
        else ""
    )

    return f"""_base_ = ['{params.base_cfg}']

# Ultralytics loads *.pt pretrained weights by default; MMYOLO base runtime uses load_from=None.
{load_from_line}

# Ensure evaluator/visualizer registry entries are loaded.
{_build_custom_imports_line(is_rotated=is_rotated)}
{visualizer_line}
{_build_pipeline_block(image_size=image_size, is_rotated=is_rotated)}

max_epochs = {params.epochs}
num_classes = {params.num_classes}
img_scale = ({image_size}, {image_size})
work_dir = '{params.work_dir}'
val_interval = {val_interval}

# Base config defines train_cfg with max_epochs=500; override so user epoch count is honored.
train_cfg = dict(
    type='EpochBasedTrainLoop',
    max_epochs=max_epochs,
    val_interval=val_interval,
)

default_hooks = dict(
    param_scheduler=dict(max_epochs=max_epochs),
    checkpoint=dict(interval=val_interval),
    # Save val prediction overlays under work_dir/vis_data/ (draw=False in base config).
    visualization=dict(
        type='mmdet.DetVisualizationHook',
        draw=True,
        interval=1,
        score_thr=0.25,
    ),
)

# Keep EMA from the base config but do NOT inherit PipelineSwitchHook — it switches to
# albumentations-based train_pipeline_stage2 from the base config and crashes with
# "Key img_path is not in available keys".
custom_hooks = [
    dict(
        type='EMAHook',
        ema_type='ExpMomentumEMA',
        momentum=0.0001,
        update_buffers=True,
        strict_load=False,
        priority=49,
    ),
]

# Class names (tuple format required by MMYolo)
_classes = {params.class_names_py}

# Use absolute paths to avoid ambiguity with data_root
{_build_dataloader_block(params, is_rotated=is_rotated)}

# Evaluators must use absolute annotation file paths
{_build_evaluator_block(params, is_rotated=is_rotated)}

{model_override}
"""
