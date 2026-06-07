import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelative } from "./formatRelative";

describe("formatRelative", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns just now for recent timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
    expect(formatRelative("2026-05-31T11:59:30Z")).toBe("just now");
  });

  it("returns minutes and hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
    expect(formatRelative("2026-05-31T11:30:00Z")).toBe("30m ago");
    expect(formatRelative("2026-05-31T10:00:00Z")).toBe("2h ago");
  });

  it("returns days weeks months years", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
    expect(formatRelative("2026-05-28T12:00:00Z")).toBe("3d ago");
    expect(formatRelative("2026-05-24T12:00:00Z")).toBe("1w ago");
    expect(formatRelative("2026-02-01T12:00:00Z")).toBe("3mo ago");
    expect(formatRelative("2024-05-31T12:00:00Z")).toBe("2y ago");
  });
});
