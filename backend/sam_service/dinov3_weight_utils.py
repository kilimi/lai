"""Validate and convert DINOv3 checkpoints for INSID3 (torch.hub Meta format)."""
from __future__ import annotations

import os
import re
from typing import Any, Dict, Tuple

import torch

_MODEL_EMBED_DIM = {
    "small": 384,
    "base": 768,
    "large": 1024,
}

_META_MARKERS = ("cls_token", "blocks.0.norm1.weight", "patch_embed.proj.weight")
_HF_MARKERS = ("embeddings.cls_token", "layer.0.norm1.weight", "layer.0.attention.q_proj.weight")


def _unwrap_checkpoint(obj: Any) -> Dict[str, torch.Tensor]:
    if isinstance(obj, dict):
        if "state_dict" in obj and isinstance(obj["state_dict"], dict):
            return obj["state_dict"]
        if "teacher" in obj and isinstance(obj["teacher"], dict):
            return obj["teacher"]
        if "student" in obj and isinstance(obj["student"], dict):
            return obj["student"]
        if any(isinstance(v, torch.Tensor) for v in obj.values()):
            return obj
    raise ValueError("Unrecognized DINOv3 checkpoint structure")


def _embed_dim_from_state(state: Dict[str, torch.Tensor]) -> int | None:
    for key in ("norm.weight", "blocks.0.norm1.weight", "layer.0.norm1.weight", "embeddings.norm.weight"):
        tensor = state.get(key)
        if tensor is not None and getattr(tensor, "ndim", 0) == 1:
            return int(tensor.shape[0])
    return None


def checkpoint_format(state: Dict[str, torch.Tensor]) -> str:
    keys = list(state.keys())
    if any(k in state for k in _META_MARKERS):
        return "meta"
    if any(k in state for k in _HF_MARKERS) or any(k.startswith("layer.") for k in keys):
        return "hf"
    if any(k.startswith("embeddings.") for k in keys):
        return "hf"
    return "unknown"


def _merge_qkv(state: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
    """Merge split q/k/v projections into Meta ``attn.qkv`` tensors (+ bias_mask)."""
    out = dict(state)
    bases: set[str] = set()
    for k in list(out):
        if ".attn.q_proj.weight" in k:
            bases.add(k.split(".attn.q_proj.weight")[0])
        elif ".attn.qkv.weight" in k:
            bases.add(k.split(".attn.qkv.weight")[0])

    for base in sorted(bases):
        wq, wk, wv = f"{base}.attn.q_proj.weight", f"{base}.attn.k_proj.weight", f"{base}.attn.v_proj.weight"
        qkv_w = f"{base}.attn.qkv.weight"
        if qkv_w not in out and wq in out and wk in out and wv in out:
            out[qkv_w] = torch.cat([out.pop(wq), out.pop(wk), out.pop(wv)], dim=0)

        bq, bk, bv = f"{base}.attn.q_proj.bias", f"{base}.attn.k_proj.bias", f"{base}.attn.v_proj.bias"
        qkv_b = f"{base}.attn.qkv.bias"
        qkv_mask = f"{base}.attn.qkv.bias_mask"
        has_bias = bq in out or bk in out or bv in out
        if has_bias and qkv_b not in out:
            ref = out[bq] if bq in out else out.get(bv)
            dim = int(ref.shape[0]) if ref is not None else int(out[qkv_w].shape[0] // 3)
            dtype = ref.dtype if ref is not None else out[qkv_w].dtype
            zero = torch.zeros(dim, dtype=dtype)
            bq_t = out.pop(bq) if bq in out else zero
            bk_t = out.pop(bk) if bk in out else zero.clone()
            bv_t = out.pop(bv) if bv in out else zero.clone()
            out[qkv_b] = torch.cat([bq_t, bk_t, bv_t], dim=0)
            if qkv_mask not in out:
                mask = torch.ones_like(out[qkv_b])
                o = int(out[qkv_b].shape[0])
                mask[o // 3 : 2 * o // 3] = 0
                out[qkv_mask] = mask
        for suffix in (".attn.q_proj.bias", ".attn.k_proj.bias", ".attn.v_proj.bias"):
            out.pop(f"{base}{suffix}", None)
        for suffix in (".attn.q_proj.weight", ".attn.k_proj.weight", ".attn.v_proj.weight"):
            out.pop(f"{base}{suffix}", None)
    return out


_HUB_NAMES = {
    "small": "dinov3_vits16",
    "base": "dinov3_vitb16",
    "large": "dinov3_vitl16",
}

_NUM_HEADS = {
    "small": 6,
    "base": 12,
    "large": 16,
}


def _expected_rope_periods_len(model_size: str) -> int:
    embed_dim = _MODEL_EMBED_DIM.get(model_size, _MODEL_EMBED_DIM["base"])
    num_heads = _NUM_HEADS.get(model_size, _NUM_HEADS["base"])
    head_dim = embed_dim // num_heads
    return head_dim // 4


def _hub_template_state_dict(model_size: str) -> Dict[str, torch.Tensor]:
    """Load a fresh Meta DINOv3 model (no weights) for buffer templates (RoPE periods, etc.)."""
    hub_name = _HUB_NAMES.get(model_size, _HUB_NAMES["base"])
    import torch.hub

    ref = torch.hub.load("facebookresearch/dinov3", hub_name, pretrained=False)
    return {k: v.detach().clone() for k, v in ref.state_dict().items()}


def _fallback_rope_periods(model_size: str) -> torch.Tensor:
    """Analytic RoPE periods matching Meta DINOv3 LVD1689M ViT configs (head_dim // 4)."""
    dim = _expected_rope_periods_len(model_size)
    return torch.pow(100.0, 2.0 * torch.arange(dim, dtype=torch.float32) / float(dim))


def _fill_missing_meta_tensors(state: Dict[str, torch.Tensor], model_size: str) -> Dict[str, torch.Tensor]:
    """
    Fill RoPE periods and any other buffers present in a fresh Meta model but absent
    from HuggingFace exports (e.g. rope_embed.periods, qkv.bias_mask).
    """
    out = dict(state)
    depth = {"small": 12, "base": 12, "large": 24}.get(model_size, 12)
    for i in range(depth):
        base = f"blocks.{i}.attn"
        qkv_b = f"{base}.qkv.bias"
        qkv_mask = f"{base}.qkv.bias_mask"
        if qkv_b in out and qkv_mask not in out:
            bias = out[qkv_b]
            mask = torch.ones_like(bias)
            o = int(bias.shape[0])
            mask[o // 3 : 2 * o // 3] = 0
            out[qkv_mask] = mask

    expected_periods = _expected_rope_periods_len(model_size)
    periods = out.get("rope_embed.periods")
    if periods is None or int(periods.shape[0]) != expected_periods:
        try:
            template = _hub_template_state_dict(model_size)
            out["rope_embed.periods"] = template["rope_embed.periods"]
            for key, tensor in template.items():
                if key not in out:
                    out[key] = tensor
        except Exception:
            out["rope_embed.periods"] = _fallback_rope_periods(model_size)
    return out


def _strip_partial_meta_artifacts(state: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
    """Remove broken half-converted Meta keys before re-converting."""
    out = dict(state)
    for key in list(out):
        if ".attn.q_proj." in key or ".attn.k_proj." in key or ".attn.v_proj." in key:
            out.pop(key, None)
    return out


def _hf_to_meta(state: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
    """Convert HuggingFace Transformers DINOv3 keys to Meta/github format."""
    out: Dict[str, torch.Tensor] = {}
    for key, tensor in state.items():
        if key.startswith("model."):
            key = key[len("model.") :]
        if key.startswith("projectors.") or "bias_mask" in key or key.endswith(".inv_freq"):
            continue

        new_key = key
        if new_key == "embeddings.cls_token":
            new_key = "cls_token"
        elif new_key == "embeddings.mask_token":
            new_key = "mask_token"
            if tensor.ndim == 3 and tensor.shape[1] == 1:
                tensor = tensor.squeeze(1)
        elif new_key == "embeddings.register_tokens":
            new_key = "storage_tokens"
        elif new_key == "embeddings.patch_embeddings.weight":
            new_key = "patch_embed.proj.weight"
        elif new_key == "embeddings.patch_embeddings.bias":
            new_key = "patch_embed.proj.bias"
        elif new_key.startswith("layer."):
            rest = new_key[len("layer.") :]
            m = re.match(r"(\d+)\.(.*)", rest)
            if not m:
                continue
            layer_idx, suffix = m.group(1), m.group(2)
            if suffix.startswith("layer_scale1.lambda1"):
                new_key = f"blocks.{layer_idx}.ls1.gamma"
            elif suffix.startswith("layer_scale2.lambda1"):
                new_key = f"blocks.{layer_idx}.ls2.gamma"
            elif suffix.startswith("norm1."):
                new_key = f"blocks.{layer_idx}.norm1.{suffix.split('.', 1)[1]}"
            elif suffix.startswith("norm2."):
                new_key = f"blocks.{layer_idx}.norm2.{suffix.split('.', 1)[1]}"
            elif suffix.startswith("attention.o_proj."):
                new_key = f"blocks.{layer_idx}.attn.proj.{suffix.split('.', 2)[2]}"
            elif suffix.startswith("attention.q_proj."):
                new_key = f"blocks.{layer_idx}.attn.q_proj.{suffix.split('.', 2)[2]}"
            elif suffix.startswith("attention.k_proj."):
                new_key = f"blocks.{layer_idx}.attn.k_proj.{suffix.split('.', 2)[2]}"
            elif suffix.startswith("attention.v_proj."):
                new_key = f"blocks.{layer_idx}.attn.v_proj.{suffix.split('.', 2)[2]}"
            elif suffix.startswith("mlp.up_proj."):
                new_key = f"blocks.{layer_idx}.mlp.fc1.{suffix.split('.', 2)[2]}"
            elif suffix.startswith("mlp.down_proj."):
                new_key = f"blocks.{layer_idx}.mlp.fc2.{suffix.split('.', 2)[2]}"
            else:
                continue
        elif new_key == "norm.weight":
            pass
        elif new_key == "norm.bias":
            pass
        else:
            continue
        out[new_key] = tensor

    return _merge_qkv(out)


def convert_to_meta_state_dict(state: Dict[str, torch.Tensor], model_size: str = "base") -> Dict[str, torch.Tensor]:
    fmt = checkpoint_format(state)
    if fmt == "meta":
        converted = _strip_partial_meta_artifacts(state)
        converted = _merge_qkv(converted)
        return _fill_missing_meta_tensors(converted, model_size)
    if fmt == "hf":
        converted = _hf_to_meta(state)
        if not any(k in converted for k in _META_MARKERS):
            raise ValueError("HuggingFace checkpoint could not be converted to Meta DINOv3 format")
        converted = _merge_qkv(converted)
        return _fill_missing_meta_tensors(converted, model_size)
    raise ValueError(
        "Unrecognized DINOv3 checkpoint format. INSID3 needs Meta/GitHub .pth weights "
        "(keys like cls_token, blocks.0.norm1.weight), not arbitrary training checkpoints."
    )


def validate_embed_dim(state: Dict[str, torch.Tensor], model_size: str) -> None:
    expected = _MODEL_EMBED_DIM.get(model_size, _MODEL_EMBED_DIM["base"])
    found = _embed_dim_from_state(state)
    if found is None:
        return
    if found != expected:
        size_hint = {v: k for k, v in _MODEL_EMBED_DIM.items()}.get(found, "unknown")
        raise ValueError(
            f"DINOv3 checkpoint embedding dim {found} does not match INSID3 model_size={model_size!r} "
            f"(expected {expected}). The file may be a {size_hint!r} checkpoint renamed incorrectly, "
            f"or the wrong HuggingFace artifact."
        )


def load_and_prepare_checkpoint(path: str, model_size: str) -> Dict[str, torch.Tensor]:
    raw = torch.load(path, map_location="cpu", weights_only=True)
    state = _unwrap_checkpoint(raw)
    state = convert_to_meta_state_dict(state, model_size=model_size)
    validate_embed_dim(state, model_size)
    return state


def ensure_meta_checkpoint_file(src_path: str, dest_path: str, model_size: str) -> str:
    """
    Ensure dest_path contains a Meta-format DINOv3 checkpoint for INSID3/torch.hub.
    Converts HuggingFace-format .pth in place when needed.
    """
    state = load_and_prepare_checkpoint(src_path, model_size)
    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    if os.path.isfile(dest_path):
        try:
            existing = load_and_prepare_checkpoint(dest_path, model_size)
            if set(existing.keys()) == set(state.keys()):
                return dest_path
        except Exception:
            pass
    torch.save(state, dest_path)
    return dest_path


def invalidate_cached_meta_conversion(pretrain_dir: str, model_size: str) -> None:
    """Remove a previously saved broken Meta conversion so HF source is re-converted."""
    fname = canonical_filename(model_size)
    for path in (
        os.path.join(pretrain_dir, fname),
        os.path.join(pretrain_dir, f"{fname}.meta-converted.pth"),
    ):
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass


def format_mismatch_help(model_size: str, path: str) -> str:
    fname = os.path.basename(path)
    return (
        f"DINOv3 weights at {path} are not compatible with INSID3 model_size={model_size!r}. "
        "INSID3 requires Meta/GitHub checkpoints (download via "
        "`python backend/scripts/download_dinov3_models.py` or Meta CDN "
        "https://dl.fbaipublicfiles.com/dinov3/dinov3_vitb16/dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth). "
        "HuggingFace Transformers weights (keys like layer.0.attention…) must be converted; "
        f"do not rename a ViT-S ({_WEIGHT_FILENAMES_HINT['small']}) file as {fname}. "
        "After fixing weights, restart sam_service."
    )


CANONICAL_FILENAMES = {
    "small": "dinov3_vits16_pretrain_lvd1689m-08c60483.pth",
    "base": "dinov3_vitb16_pretrain_lvd1689m-73cec8be.pth",
    "large": "dinov3_vitl16_pretrain_lvd1689m-8aa4cbdd.pth",
}

# Back-compat alias used in error messages.
_WEIGHT_FILENAMES_HINT = CANONICAL_FILENAMES

# Common names when exporting from HuggingFace `torch.save(model.state_dict(), ...)`.
_ALT_FILENAMES: dict[str, tuple[str, ...]] = {
    "small": (
        "dinov3-vits16-pretrain-lvd1689m.pth",
        "dinov3_vits16_pretrain_lvd1689m.pth",
    ),
    "base": (
        "dinov3-vitb16-pretrain-lvd1689m.pth",
        "dinov3_vitb16_pretrain_lvd1689m.pth",
    ),
    "large": (
        "dinov3-vitl16-pretrain-lvd1689m.pth",
        "dinov3_vitl16_pretrain_lvd1689m.pth",
    ),
}

_MODEL_TOKENS = {
    "small": "vits16",
    "base": "vitb16",
    "large": "vitl16",
}


def canonical_filename(model_size: str) -> str:
    return CANONICAL_FILENAMES.get(model_size, CANONICAL_FILENAMES["base"])


def list_dinov3_pth_files(weights_dir: str) -> list[str]:
    if not weights_dir or not os.path.isdir(weights_dir):
        return []
    return sorted(
        name for name in os.listdir(weights_dir) if name.lower().endswith(".pth")
    )


def _normalized_stem(filename: str) -> str:
    return os.path.basename(filename).lower().replace("-", "_").removesuffix(".pth")


def resolve_dinov3_weight_path(weights_dir: str, model_size: str) -> str | None:
    """
    Locate a DINOv3 checkpoint under weights_dir.

    Accepts the Meta canonical filename, common HuggingFace export names
    (e.g. dinov3-vitb16-pretrain-lvd1689m.pth), or any .pth whose name
    contains the expected variant token (vitb16 / vits16 / vitl16).
    """
    if not weights_dir or not os.path.isdir(weights_dir):
        return None

    token = _MODEL_TOKENS.get(model_size, _MODEL_TOKENS["base"])
    candidates: list[str] = []

    canonical = canonical_filename(model_size)
    candidates.append(os.path.join(weights_dir, canonical))
    for alt in _ALT_FILENAMES.get(model_size, ()):
        candidates.append(os.path.join(weights_dir, alt))

    for name in list_dinov3_pth_files(weights_dir):
        stem = _normalized_stem(name)
        if "dinov3" in stem and token in stem:
            candidates.append(os.path.join(weights_dir, name))

    seen: set[str] = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    return None


def diagnose_checkpoint(path: str, model_size: str) -> Tuple[str, str | None]:
    try:
        state = _unwrap_checkpoint(torch.load(path, map_location="cpu", weights_only=True))
    except Exception as exc:
        return "error", f"cannot read checkpoint: {exc}"
    fmt = checkpoint_format(state)
    dim = _embed_dim_from_state(state)
    expected = _MODEL_EMBED_DIM.get(model_size, 768)
    if fmt == "meta":
        if dim is not None and dim != expected:
            return "dim_mismatch", f"embed_dim={dim}, expected {expected} for model_size={model_size!r}"
        if "rope_embed.periods" not in state:
            return "partial_meta", "missing rope_embed.periods (incomplete HF conversion)"
        expected_p = _expected_rope_periods_len(model_size)
        if int(state["rope_embed.periods"].shape[0]) != expected_p:
            return (
                "partial_meta",
                f"rope_embed.periods shape {tuple(state['rope_embed.periods'].shape)} "
                f"expected [{expected_p}]",
            )
        if any(f"blocks.{i}.attn.q_proj.bias" in state for i in range(24)):
            return "partial_meta", "unmerged q/k/v attention biases"
        if "blocks.0.attn.qkv.bias" in state and "blocks.0.attn.qkv.bias_mask" not in state:
            return "partial_meta", "missing qkv.bias_mask"
        return "ok", None
    if fmt == "hf":
        return "hf", f"HuggingFace Transformers format (embed_dim={dim})"
    if dim is not None and dim != expected:
        return "dim_mismatch", f"embed_dim={dim}, expected {expected} for model_size={model_size!r}"
    return fmt, f"format={fmt}, embed_dim={dim}"
