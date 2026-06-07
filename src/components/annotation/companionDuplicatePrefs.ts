/** Session key for which companion layers receive mirrored annotation saves. */
export const COMPANION_DUPLICATE_STORAGE_KEY = "annotation-companion-duplicate-v2";

/** Layers the user explicitly disabled copy for (survives hydrate / remount). */
export const COMPANION_COPY_OFF_STORAGE_KEY = "annotation-companion-copy-off-v1";

export function readCopyOffCollectionIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(COMPANION_COPY_OFF_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((id) => String(id)).filter(Boolean));
      }
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

export function writeCopyOffCollectionIds(ids: Iterable<string>): string[] {
  const normalized = [...new Set([...ids].map((id) => String(id)).filter(Boolean))];
  try {
    sessionStorage.setItem(COMPANION_COPY_OFF_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* ignore */
  }
  return normalized;
}

/** Read copy-target collection ids (respects explicit copy-off list). */
export function readCompanionDuplicateIds(): string[] {
  const copyOff = readCopyOffCollectionIds();
  try {
    const raw = sessionStorage.getItem(COMPANION_DUPLICATE_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((id) => String(id))
          .filter((id) => id && !copyOff.has(id));
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** Persist copy-target collection ids and return the written list (minus copy-off). */
export function writeCompanionDuplicateIds(ids: string[]): string[] {
  const copyOff = readCopyOffCollectionIds();
  const normalized = ids
    .map((id) => String(id))
    .filter((id) => id && !copyOff.has(id));
  try {
    sessionStorage.setItem(
      COMPANION_DUPLICATE_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    /* ignore */
  }
  return normalized;
}

/** Enable or disable mirroring onto a companion collection (sync session immediately). */
export function setCollectionCopyEnabled(
  collectionId: string,
  enabled: boolean,
): string[] {
  const cid = String(collectionId);
  const copyOff = readCopyOffCollectionIds();
  if (enabled) {
    copyOff.delete(cid);
  } else {
    copyOff.add(cid);
  }
  writeCopyOffCollectionIds(copyOff);

  let enabledIds: string[] = [];
  try {
    const raw = sessionStorage.getItem(COMPANION_DUPLICATE_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        enabledIds = parsed.map((id) => String(id)).filter(Boolean);
      }
    }
  } catch {
    /* ignore */
  }

  if (enabled) {
    if (!enabledIds.includes(cid)) enabledIds = [...enabledIds, cid];
  } else {
    enabledIds = enabledIds.filter((id) => id !== cid);
  }

  return writeCompanionDuplicateIds(enabledIds);
}

export function isCollectionCopyEnabled(collectionId: string): boolean {
  return !readCopyOffCollectionIds().has(String(collectionId))
    && readCompanionDuplicateIds().includes(String(collectionId));
}
