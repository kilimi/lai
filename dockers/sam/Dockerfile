# syntax=docker/dockerfile:1.4
# Single image for SAM 2 + SAM 3. PyTorch 2.7 / CUDA 12.6 required by SAM 3; SAM 2 runs on it.
# Build context: backend/sam_service/ (app). Pip lockfiles: additional_context docker_deps → dockers/sam/.
FROM pytorch/pytorch:2.7.1-cuda12.6-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates libgl1 git build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=docker_deps requirements.txt requirements-git.txt ./
ENV SAM2_BUILD_CUDA=0
ENV HF_HOME=/models/hf_cache
ENV HUGGINGFACE_HUB_CACHE=/models/hf_cache
ENV HUGGINGFACE_HUB_DISABLE_TELEMETRY=1

# SAM-2's pyproject often fails inside pip's isolated build env (missing/wrong torch).
# Install wheels first, then git deps with --no-build-isolation so setup.py sees image PyTorch.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel packaging \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-build-isolation -r requirements-git.txt

# SAM 2: pre-download checkpoint at build. SAM 3: use runtime volume or HF (SAM3_CHECKPOINT_PATH / HF_TOKEN).
RUN mkdir -p /models/hf_cache /models/sam3 \
    && python -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='facebook/sam2.1-hiera-small', filename='sam2.1_hiera_small.pt'); print('SAM 2 checkpoint downloaded.')"

COPY app.py utils.py ./

ENV FLASK_APP=app.py
ENV FLASK_RUN_HOST=0.0.0.0
ENV SAM2_MODEL_ID=facebook/sam2.1-hiera-small
# Optional: set to /models/sam3/sam3.pt when mounting a volume with local checkpoint
ENV SAM3_CHECKPOINT_PATH=/models/sam3/sam3.pt

EXPOSE 8081

CMD ["gunicorn", "-b", "0.0.0.0:8081", "app:app", "--workers", "1", "--timeout", "120"]
