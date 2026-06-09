import { attachmentFilenameFromContentDisposition } from '@/lib/evaluationTableDisplay';

export type DownloadProgressPhase = 'preparing' | 'downloading' | 'saving';

export type DownloadProgressUpdate = {
  phase: DownloadProgressPhase;
  loaded: number;
  total: number | null;
  percent: number | null;
};

export async function downloadFileWithProgress(
  url: string,
  options: {
    filenameFallback: string;
    onProgress: (update: DownloadProgressUpdate) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { filenameFallback, onProgress, signal } = options;

  onProgress({ phase: 'preparing', loaded: 0, total: null, percent: null });

  const response = await fetch(url, { method: 'GET', signal });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  const contentDisposition = response.headers.get('Content-Disposition');
  let filename = filenameFallback;
  const headerFilename = attachmentFilenameFromContentDisposition(contentDisposition);
  if (headerFilename) filename = headerFilename;

  const contentLength = response.headers.get('Content-Length');
  const totalBytes =
    contentLength && !Number.isNaN(Number(contentLength))
      ? Number(contentLength)
      : null;

  if (!response.body) {
    onProgress({ phase: 'downloading', loaded: 0, total: totalBytes, percent: totalBytes ? 0 : null });
    const blob = await response.blob();
    onProgress({
      phase: 'saving',
      loaded: blob.size,
      total: totalBytes ?? blob.size,
      percent: 100,
    });
    triggerBrowserDownload(blob, filename);
    return;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      const percent =
        totalBytes && totalBytes > 0
          ? Math.min(100, Math.round((loaded / totalBytes) * 100))
          : null;
      onProgress({ phase: 'downloading', loaded, total: totalBytes, percent });
    }
  }

  onProgress({
    phase: 'saving',
    loaded,
    total: totalBytes ?? loaded,
    percent: 100,
  });

  const blob = new Blob(chunks as BlobPart[]);
  triggerBrowserDownload(blob, filename);
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  window.URL.revokeObjectURL(objectUrl);
  document.body.removeChild(anchor);
}
