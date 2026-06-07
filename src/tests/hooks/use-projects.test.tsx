/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProjects } from "@/hooks/use-projects";
import type { Project } from "@/types";

const mockGetProjects = vi.fn();
const mockApi = { getProjects: mockGetProjects };

vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({
    api: mockApi,
    isConfigured: true,
  }),
}));

const sampleProject: Project = {
  id: 1,
  name: "P1",
  description: "",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  is_project: true,
  datasets: [],
};

describe("useProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjects.mockResolvedValue({
      success: true,
      data: [sampleProject],
    });
  });

  it("loads and normalizes projects", async () => {
    const { result } = renderHook(() => useProjects(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0].datasets).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("sets error when API fails", async () => {
    mockGetProjects.mockResolvedValueOnce({
      success: false,
      error: "boom",
    });

    const { result } = renderHook(() => useProjects(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.projects).toEqual([]);
  });

  it("refetches when refetchKey changes", async () => {
    const { result, rerender } = renderHook(({ key }) => useProjects(key), {
      initialProps: { key: 0 },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetProjects).toHaveBeenCalledTimes(1);

    rerender({ key: 1 });
    await waitFor(() => expect(mockGetProjects).toHaveBeenCalledTimes(2));
  });
});
