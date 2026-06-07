"""In-process video frame extraction progress (poll while sync request runs)."""
from __future__ import annotations

import threading
import time
from typing import Dict, Optional

_PROGRESS: Dict[str, dict] = {}
_LOCK = threading.Lock()
_TTL_SECONDS = 300


def video_progress_set(job_id: str, **fields) -> None:
    if not job_id:
        return
    now = time.time()
    with _LOCK:
        entry = _PROGRESS.get(job_id) or {"job_id": job_id, "created_at": now}
        entry.update(fields)
        entry["updated_at"] = now
        _PROGRESS[job_id] = entry
        stale = [
            jid
            for jid, e in _PROGRESS.items()
            if e.get("stage") in ("done", "error")
            and now - e.get("updated_at", now) > _TTL_SECONDS
        ]
        for jid in stale:
            _PROGRESS.pop(jid, None)


def video_progress_get(job_id: str) -> Optional[dict]:
    with _LOCK:
        entry = _PROGRESS.get(job_id)
        return dict(entry) if entry else None
