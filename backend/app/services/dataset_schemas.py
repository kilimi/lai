"""Pydantic request models for dataset APIs."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel

class MergeStrategyConfig(BaseModel):
    # 'exact' | 'iou' | 'priority' | 'union'
    strategy: str = "exact"
    iou_threshold: float = 0.5
    # 'largest' | 'smallest' | 'first' | 'last'
    tie_breaker: str = "largest"
    # Ordered list of annotation_file_ids; index 0 = highest priority
    priority_order: Optional[List[str]] = None
    # 'keep' | 'priority'
    cross_class: str = "keep"
    cross_class_iou: float = 0.7


class MergeAnnotationFilesRequest(BaseModel):
    annotation_file_ids: List[str]
    merged_filename: Optional[str] = None
    strategy: Optional[MergeStrategyConfig] = None


class ViewFiftyOneRequest(BaseModel):
    annotation_file_ids: List[str]
    # Which image collection (layer) to show in FiftyOne; default = RGB / non-depth preferred
    image_collection_id: Optional[int] = None


class MoveDatasetRequest(BaseModel):
    project_id: int
