import * as React from 'react';
import { SAM3_HF_MODEL_URL } from '@/components/annotation/foundationModelLinks';

/** Shown when SAM 3 is selected but weights are not mounted in sam_service. */
export function Sam3UnavailablePanel() {
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-[11px] text-foreground">
      SAM 3 (point / text) is not available. Request access and download SAM 3 weights from{' '}
      <a
        href={SAM3_HF_MODEL_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        Hugging Face
      </a>{' '}
      (license approval required), place the checkpoint in{' '}
      <code className="text-[10px]">SAM3_MODELS_HOST_PATH</code> as{' '}
      <code className="text-[10px]">SAM3_CHECKPOINT_FILENAME</code> (run{' '}
      <code className="text-[10px]">lai install</code>), then restart{' '}
      <code className="text-[10px]">sam_service</code> with the GPU profile.
    </div>
  );
}
