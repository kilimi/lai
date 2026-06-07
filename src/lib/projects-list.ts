import type { Project } from "@/types";

export type ProjectSortOrder = "newest" | "oldest" | "name";

export interface ProjectListStats {
  totalProjects: number;
  totalDatasets: number;
  totalImages: number;
}

export interface FilterProjectsOptions {
  searchQuery: string;
  selectedTag: string | null;
}

/** Normalize API payload (ensure datasets array exists). */
export function normalizeProjects(raw: Project[]): Project[] {
  return raw.map((project) => ({
    ...project,
    datasets: project.datasets || [],
  }));
}

export function filterProjects(
  projects: Project[],
  { searchQuery, selectedTag }: FilterProjectsOptions,
): Project[] {
  let result = [...projects];

  if (searchQuery.trim()) {
    const query = searchQuery.trim().toLowerCase();
    result = result.filter((project) => {
      const nameMatch = project.name.toLowerCase().includes(query);
      const descMatch = (project.description || "").toLowerCase().includes(query);
      const tagMatch =
        project.tags?.some((tag) => tag.toLowerCase().includes(query)) ?? false;
      return nameMatch || descMatch || tagMatch;
    });
  }

  if (selectedTag) {
    result = result.filter(
      (project) => project.tags && project.tags.includes(selectedTag),
    );
  }

  return result;
}

export function sortProjects(projects: Project[], sortOrder: ProjectSortOrder): Project[] {
  const result = [...projects];
  switch (sortOrder) {
    case "newest":
      return result.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    case "oldest":
      return result.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    case "name":
      return result.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return result;
  }
}

export function filterAndSortProjects(
  projects: Project[],
  options: FilterProjectsOptions & { sortOrder: ProjectSortOrder },
): Project[] {
  return sortProjects(filterProjects(projects, options), options.sortOrder);
}

/** Sorted union of all tags across projects. */
export function collectProjectTags(projects: Project[]): string[] {
  return Array.from(new Set(projects.flatMap((p) => p.tags || []))).sort();
}

export function computeProjectListStats(projects: Project[]): ProjectListStats {
  return {
    totalProjects: projects.length,
    totalDatasets: projects.reduce((acc, p) => acc + (p.datasets?.length || 0), 0),
    totalImages: projects.reduce(
      (acc, p) =>
        acc +
        (p.datasets?.reduce((datasetAcc, d) => datasetAcc + (d.image_count || 0), 0) || 0),
      0,
    ),
  };
}
