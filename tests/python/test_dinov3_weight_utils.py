"""Tests for DINOv3 checkpoint format helpers (sam_service)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import torch

SAM_SERVICE = Path(__file__).resolve().parents[2] / "backend" / "sam_service"
if str(SAM_SERVICE) not in sys.path:
    sys.path.append(str(SAM_SERVICE))

from dinov3_weight_utils import (  # noqa: E402
    checkpoint_format,
    convert_to_meta_state_dict,
    validate_embed_dim,
)


def test_meta_checkpoint_format_detected():
    state = {
        "cls_token": torch.zeros(1, 1, 768),
        "blocks.0.norm1.weight": torch.zeros(768),
        "norm.weight": torch.zeros(768),
    }
    assert checkpoint_format(state) == "meta"


def test_hf_checkpoint_format_detected():
    state = {
        "embeddings.cls_token": torch.zeros(1, 1, 768),
        "layer.0.norm1.weight": torch.zeros(768),
        "layer.0.attention.q_proj.weight": torch.zeros(768, 768),
    }
    assert checkpoint_format(state) == "hf"


def test_validate_embed_dim_mismatch():
    state = {"norm.weight": torch.zeros(384)}
    with pytest.raises(ValueError, match="embedding dim 384"):
        validate_embed_dim(state, "base")


def test_resolve_hf_style_filename(tmp_path):
    from dinov3_weight_utils import resolve_dinov3_weight_path

    hf_name = "dinov3-vitb16-pretrain-lvd1689m.pth"
    (tmp_path / hf_name).write_bytes(b"x")
    resolved = resolve_dinov3_weight_path(str(tmp_path), "base")
    assert resolved is not None
    assert resolved.endswith(hf_name)


def test_hf_to_meta_converts_layer_scale():
    state = {
        "embeddings.cls_token": torch.zeros(1, 1, 768),
        "embeddings.register_tokens": torch.zeros(1, 4, 768),
        "embeddings.mask_token": torch.zeros(1, 1, 768),
        "embeddings.patch_embeddings.weight": torch.zeros(768, 3, 16, 16),
        "layer.0.norm1.weight": torch.zeros(768),
        "layer.0.norm1.bias": torch.zeros(768),
        "layer.0.norm2.weight": torch.zeros(768),
        "layer.0.norm2.bias": torch.zeros(768),
        "layer.0.layer_scale1.lambda1": torch.ones(768),
        "layer.0.layer_scale2.lambda1": torch.ones(768),
        "layer.0.attention.q_proj.weight": torch.zeros(768, 768),
        "layer.0.attention.q_proj.bias": torch.ones(768),
        "layer.0.attention.k_proj.weight": torch.zeros(768, 768),
        "layer.0.attention.v_proj.weight": torch.zeros(768, 768),
        "layer.0.attention.v_proj.bias": torch.ones(768) * 2,
        "layer.0.attention.o_proj.weight": torch.zeros(768, 768),
        "layer.0.mlp.up_proj.weight": torch.zeros(3072, 768),
        "layer.0.mlp.down_proj.weight": torch.zeros(768, 3072),
        "norm.weight": torch.zeros(768),
        "norm.bias": torch.zeros(768),
    }
    meta = convert_to_meta_state_dict(state, model_size="base")
    assert "cls_token" in meta
    assert "blocks.0.ls2.gamma" in meta
    assert "blocks.0.attn.qkv.weight" in meta
    assert "blocks.0.attn.qkv.bias" in meta
    assert "blocks.0.attn.qkv.bias_mask" in meta
    assert "rope_embed.periods" in meta
    assert meta["rope_embed.periods"].shape[0] == 16
    assert "blocks.0.attn.q_proj.bias" not in meta
    qkv_bias = meta["blocks.0.attn.qkv.bias"]
    assert int(qkv_bias[:768].sum()) == 768
    assert int(qkv_bias[768:1536].sum()) == 0
    assert int(qkv_bias[1536:].sum()) == 768 * 2
