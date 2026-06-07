import { describe, it, expect } from "vitest";
import {
  collectProjectTags,
  computeProjectListStats,
  filterAndSortProjects,
  filterProjects,
  normalizeProjects,
  sortProjects,
} from "./projects-list";
import type { Project } from "@/types";

function project(overrides: Partial<Project> & { id: number; name: string }): Project {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? "",
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
    is_project: true,
    datasets: overrides.datasets ?? [],
    tags: overrides.tags,
    ...overrides,
  };
}

describe("projects-list", () => {
  const sample = [
    project({
      id: 1,
      name: "Alpha",
      description: "vision work",
      created_at: "2026-03-01T00:00:00.000Z",
      tags: ["ml"],
      datasets: [{ id: 10, name: "d1", description: "", tags: [], created_at: "", updated_at: "", image_count: 5, annotation_count: 0, annotation_file_count: 0, project_id: 1 }],
    }),
    project({
      id: 2,
      name: "Beta Project",
      description: "other",
      created_at: "2026-01-15T00:00:00.000Z",
      tags: ["test", "ml"],
      datasets: [{ id: 11, name: "d2", description: "", tags: [], created_at: "", updated_at: "", image_count: 2, annotation_count: 0, annotation_file_count: 0, project_id: 2 }],
    }),
  ] as Project[];

  it("normalizeProjects ensures datasets array", () => {
    const raw = [{ ...sample[0], datasets: undefined }] as Project[];
    expect(normalizeProjects(raw)[0].datasets).toEqual([]);
  });

  it("filterProjects matches name, description, and tags", () => {
    expect(filterProjects(sample, { searchQuery: "vision", selectedTag: null })).toHaveLength(1);
    expect(filterProjects(sample, { searchQuery: "beta", selectedTag: null })[0].name).toBe("Beta Project");
    expect(filterProjects(sample, { searchQuery: "", selectedTag: "ml" })).toHaveLength(2);
    expect(filterProjects(sample, { searchQuery: "", selectedTag: "missing" })).toHaveLength(0);
  });

  it("sortProjects orders by newest, oldest, and name", () => {
    expect(sortProjects(sample, "newest").map((p) => p.id)).toEqual([1, 2]);
    expect(sortProjects(sample, "oldest").map((p) => p.id)).toEqual([2, 1]);
    expect(sortProjects(sample, "name").map((p) => p.name)).toEqual(["Alpha", "Beta Project"]);
  });

  it("filterAndSortProjects combines filter and sort", () => {
    const result = filterAndSortProjects(sample, {
      searchQuery: "beta",
      selectedTag: null,
      sortOrder: "name",
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it("collectProjectTags returns sorted unique tags", () => {
    expect(collectProjectTags(sample)).toEqual(["ml", "test"]);
  });

  it("computeProjectListStats aggregates counts", () => {
    expect(computeProjectListStats(sample)).toEqual({
      totalProjects: 2,
      totalDatasets: 2,
      totalImages: 7,
    });
  });
});
