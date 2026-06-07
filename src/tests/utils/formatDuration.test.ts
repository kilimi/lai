import { describe, it, expect } from "vitest";
import { formatDuration } from "../../utils/formatDuration";

describe("formatDuration", () => {
  it("formats durations less than a minute", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:00:30.000Z";
    expect(formatDuration(start, end)).toBe("30s");
  });

  it("formats durations in minutes and seconds", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:05:30.000Z";
    expect(formatDuration(start, end)).toBe("5m 30s");
  });

  it("formats durations in hours and minutes", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T02:30:45.000Z";
    expect(formatDuration(start, end)).toBe("2h 30m");
  });

  it("uses current time when end is not provided", () => {
    const start = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    const result = formatDuration(start);
    // Should be around 5s, allowing for small timing differences
    expect(result).toMatch(/^[45]s$/);
  });

  it("handles zero duration", () => {
    const time = "2024-01-01T00:00:00.000Z";
    expect(formatDuration(time, time)).toBe("0s");
  });

  it("handles durations with only hours (no minutes)", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T03:00:00.000Z";
    expect(formatDuration(start, end)).toBe("3h 0m");
  });

  it("handles long durations correctly", () => {
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-02T05:30:45.000Z"; // 1 day, 5h, 30m, 45s
    expect(formatDuration(start, end)).toBe("29h 30m");
  });
});
