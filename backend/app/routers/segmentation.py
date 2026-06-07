from fastapi import APIRouter, Request, HTTPException
import base64
import os
from urllib.parse import urlparse, urlunparse

router = APIRouter()

# Single SAM service runs both SAM 2 and SAM 3; health returns sam_available and sam3_available.
SAM_SERVICE_URL = os.environ.get("SAM_SERVICE_URL", "http://sam_service:8081")


async def _sam_health(url: str):
    """GET service health; returns (ok: bool, body: dict or None)."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{url}/health")
            if r.status_code == 200:
                try:
                    return True, r.json()
                except Exception:
                    return True, {}
            return False, None
    except Exception:
        pass
    try:
        import requests
        r = requests.get(f"{url}/health", timeout=3)
        if r.status_code == 200:
            try:
                return True, r.json()
            except Exception:
                return True, {}
        return False, None
    except Exception:
        pass
    return False, None


@router.get("/segment/ready")
async def segment_ready():
    """Return 200 if SAM 2 is available (unified service reports sam_available)."""
    ok, body = await _sam_health(SAM_SERVICE_URL)
    if ok and (body or {}).get("sam_available"):
        return {"available": True}
    raise HTTPException(status_code=503, detail="SAM service not available")


@router.get("/segment/ready/sam3")
async def segment_ready_sam3():
    """Return 200 if SAM 3 is available (unified service reports sam3_available)."""
    ok, body = await _sam_health(SAM_SERVICE_URL)
    if ok and (body or {}).get("sam3_available"):
        return {"available": True}
    raise HTTPException(status_code=503, detail="SAM 3 not available")


@router.post("/segment")
async def proxy_segment(request: Request):
    """Proxy to unified SAM service. Body may include "model": "sam2" | "sam3" (default: sam2)."""
    body = await request.json()
    # Unified service expects model in body and routes internally; keep it
    sam_url = f"{SAM_SERVICE_URL}/segment"

    # If an imageUrl is present, try to fetch the image server-side and attach imageB64
    image_url = body.get('imageUrl') if isinstance(body, dict) else None
    if image_url:
        # Attempt to fetch the image; prefer async httpx in this async endpoint
        fetched = None
        try:
            import httpx
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    # First try the provided URL
                    resp = await client.get(image_url)
                    if resp.status_code == 200:
                        fetched = resp.content
            except Exception:
                # If direct fetch fails and URL looks like localhost, try container-internal port 8000
                parsed = urlparse(image_url)
                if parsed.hostname in ('localhost', '127.0.0.1'):
                    internal = parsed._replace(netloc=f'127.0.0.1:8000')
                    try:
                        async with httpx.AsyncClient(timeout=15.0) as client:
                            resp = await client.get(urlunparse(internal))
                            if resp.status_code == 200:
                                fetched = resp.content
                    except Exception:
                        pass
        except ModuleNotFoundError:
            # sync fallback
            try:
                import requests
                try:
                    resp = requests.get(image_url, timeout=15.0)
                    if resp.status_code == 200:
                        fetched = resp.content
                except Exception:
                    parsed = urlparse(image_url)
                    if parsed.hostname in ('localhost', '127.0.0.1'):
                        internal = parsed._replace(netloc=f'127.0.0.1:8000')
                        try:
                            resp = requests.get(urlunparse(internal), timeout=15.0)
                            if resp.status_code == 200:
                                fetched = resp.content
                        except Exception:
                            pass
            except Exception:
                # nothing we can do here
                fetched = None

        if fetched:
            try:
                body["imageB64"] = base64.b64encode(fetched).decode("ascii")
                body.pop("imageUrl", None)
            except Exception:
                pass

    # Try to use httpx if installed (async). If not, fall back to requests (sync) in a thread.
    try:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(sam_url, json=body)
                if resp.status_code >= 400:
                    raise HTTPException(status_code=resp.status_code, detail=resp.text)
                return resp.json()
        except Exception as e:
            # Convert connection/timeout errors into a 502 with the underlying message for easier debugging
            raise HTTPException(status_code=502, detail=f'Failed to reach sam service (httpx): {e}')
    except ModuleNotFoundError:
        # fallback to synchronous requests
        try:
            import requests
            resp = requests.post(sam_url, json=body, timeout=30.0)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f'Failed to reach sam service: {e}')

        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return resp.json()
