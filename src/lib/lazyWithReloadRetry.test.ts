import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { importWithReloadRetry } from "@/lib/lazyWithReloadRetry";

describe("importWithReloadRetry", () => {
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reloadMock = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears retry flag after a successful import", async () => {
    sessionStorage.setItem("lazy-retry:RenameClassDialog", "1");

    const mod = await importWithReloadRetry(
      async () => ({ default: "ok" }),
      "RenameClassDialog",
      { reload: reloadMock },
    );

    expect(mod.default).toBe("ok");
    expect(sessionStorage.getItem("lazy-retry:RenameClassDialog")).toBeNull();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads once and stores retry flag on first chunk-load failure", async () => {
    const chunkError = new TypeError("Failed to fetch dynamically imported module");

    void importWithReloadRetry(
      async () => {
        throw chunkError;
      },
      "RenameClassDialog",
      { reload: reloadMock },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("lazy-retry:RenameClassDialog")).toBe("1");
  });

  it("throws and clears retry flag after repeated chunk-load failure", async () => {
    sessionStorage.setItem("lazy-retry:RenameClassDialog", "1");
    const chunkError = new TypeError("Failed to fetch dynamically imported module");

    await expect(
      importWithReloadRetry(
        async () => {
          throw chunkError;
        },
        "RenameClassDialog",
        { reload: reloadMock },
      ),
    ).rejects.toThrow("Failed to fetch dynamically imported module");

    expect(reloadMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("lazy-retry:RenameClassDialog")).toBeNull();
  });

  it("does not reload for non-chunk errors", async () => {
    await expect(
      importWithReloadRetry(
        async () => {
          throw new Error("some other failure");
        },
        "RenameClassDialog",
        { reload: reloadMock },
      ),
    ).rejects.toThrow("some other failure");

    expect(reloadMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("lazy-retry:RenameClassDialog")).toBeNull();
  });
});
