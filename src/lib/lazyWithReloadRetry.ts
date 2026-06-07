import { ComponentType, lazy } from "react";

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const text = message.toLowerCase();
  return (
    text.includes("failed to fetch dynamically imported module") ||
    text.includes("importing a module script failed") ||
    text.includes("chunkloaderror")
  );
}

export function lazyWithReloadRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  retryKey: string,
) {
  return lazy(() => importWithReloadRetry(importer, retryKey));
}

export async function importWithReloadRetry<T>(
  importer: () => Promise<{ default: T }>,
  retryKey: string,
  deps?: {
    reload?: () => void;
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  },
): Promise<{ default: T }> {
  const hasWindow = typeof window !== "undefined";
  const storage = deps?.storage ?? (hasWindow ? sessionStorage : undefined);
  const reload = deps?.reload ?? (hasWindow ? () => window.location.reload() : undefined);

  try {
    const mod = await importer();
    if (storage) {
      try {
        storage.removeItem(`lazy-retry:${retryKey}`);
      } catch {
        // no-op
      }
    }
    return mod;
  } catch (error) {
    if (storage && reload && isChunkLoadError(error)) {
      const storageKey = `lazy-retry:${retryKey}`;
      let alreadyRetried = false;
      try {
        alreadyRetried = storage.getItem(storageKey) === "1";
      } catch {
        alreadyRetried = false;
      }

      // Reload once so browser fetches the latest index/chunk graph after deploy.
      if (!alreadyRetried) {
        try {
          storage.setItem(storageKey, "1");
        } catch {
          // no-op
        }
        reload();
        await new Promise<never>(() => {});
      }

      try {
        storage.removeItem(storageKey);
      } catch {
        // no-op
      }
    }
    throw error;
  }
}
