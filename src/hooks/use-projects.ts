import { useState, useEffect, useCallback } from "react";
import { useApi } from "./use-api";
import { Project } from "@/types";
import { normalizeProjects } from "@/lib/projects-list";

/**
 * Fetch projects with their datasets for the home / projects list page.
 */
export const useProjects = (refetchKey = 0) => {
  const { api, isConfigured } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    if (!isConfigured || !api) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await api.getProjects();

      if (response.success && response.data) {
        setProjects(normalizeProjects(response.data));
      } else {
        setError(response.error || "Failed to fetch projects");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch projects");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [api, isConfigured]);

  useEffect(() => {
    if (!isConfigured || !api) {
      setLoading(false);
      return;
    }
    void fetchProjects();
  }, [fetchProjects, refetchKey, isConfigured, api]);

  const refetch = useCallback(() => {
    void fetchProjects();
  }, [fetchProjects]);

  return { projects, loading, error, refetch };
};

/**
 * Hook to fetch a single project with its datasets
 */
export const useProject = (projectId: string) => {
  const { api, isConfigured } = useApi();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProject = useCallback(async () => {
    if (!isConfigured || !api || !projectId) {
      return;
    }

    try {
      setError(null);
      const response = await api.getProject(projectId);

      if (response.success && response.data) {
        setProject(response.data);
      } else {
        setError(response.error || "Failed to fetch project");
      }
    } catch (err) {
      setError("An error occurred while fetching the project");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [api, isConfigured, projectId]);

  useEffect(() => {
    setLoading(true);
    void fetchProject();
  }, [fetchProject]);

  const refetch = useCallback(() => {
    setLoading(true);
    void fetchProject();
  }, [fetchProject]);

  return { project, loading, error, refetch };
};
