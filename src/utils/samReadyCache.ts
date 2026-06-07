/** Session cache: SAM backend reported ready at least once this browser tab. */
export type SamSegmentModelKey = 'sam2' | 'sam3';

const readyByModel: Record<SamSegmentModelKey, boolean> = {
  sam2: false,
  sam3: false,
};

export function isSamModelCachedReady(model: SamSegmentModelKey): boolean {
  return readyByModel[model];
}

export function setSamModelCachedReady(model: SamSegmentModelKey, ready: boolean): void {
  readyByModel[model] = ready;
}

export function clearSamModelReadyCache(model?: SamSegmentModelKey): void {
  if (model) {
    readyByModel[model] = false;
    return;
  }
  readyByModel.sam2 = false;
  readyByModel.sam3 = false;
}
