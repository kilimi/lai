import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from './use-api';
import { useExport } from '@/contexts/ExportContext';

export interface Task {
  id: number;
  name: string;
  description: string;
  task_type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped' | 'paused';
  progress: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  project_id?: number | null;
  metadata?: any;
  task_metadata?: any;
}

export function useTasks(projectId?: number) {
  const { api, isConfigured } = useApi();
  const { isExporting } = useExport();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTasks, setActiveTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When true the popover (or equivalent UI) is visible → poll at full speed */
  const [polling, setPolling] = useState(false);
  const mountedRef = useRef(true);

  const fetchActiveTasks = useCallback(async () => {
    if (!api || !isConfigured) return;
    try {
      setLoading(true);
      const response = await api.getActiveTasks(projectId);
      if (!mountedRef.current) return;
      if (response.success) {
        setActiveTasks(response.data as Task[]);
      }
    } catch {
      /* ignore – polling will retry */
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, isConfigured, projectId]);

  const fetchAllTasks = useCallback(async () => {
    if (!api || !isConfigured) return;
    try {
      setLoading(true);
      setError(null);
      const response = await api.getTasks({
        project_id: projectId,
        limit: 100,
        recent_hours: 1,
      });
      if (!mountedRef.current) return;
      if (response.success) {
        const raw = response.data as unknown;
        const list = Array.isArray(raw)
          ? raw
          : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
            ? (raw as { data: Task[] }).data
            : [];
        setTasks(list as Task[]);
      }
    } catch {
      /* ignore */
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, isConfigured, projectId]);

  const cancelTask = async (taskId: number) => {
    if (!api || !isConfigured) return false;
    try {
      const response = await api.cancelTask(taskId);
      if (response.success) {
        await fetchActiveTasks();
        await fetchAllTasks();
        return true;
      }
      setError(response.error || 'Failed to cancel task');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
      return false;
    }
  };

  const getTaskById = async (taskId: number) => {
    if (!api || !isConfigured) return null;
    try {
      const response = await api.getTask(taskId);
      return response.success ? response.data : null;
    } catch {
      return null;
    }
  };

  // Initial fetch once the client is ready
  useEffect(() => {
    mountedRef.current = true;
    if (!isConfigured || !api) return;
    fetchActiveTasks();
    fetchAllTasks();
    return () => { mountedRef.current = false; };
  }, [api, isConfigured, projectId]);

  // Poll only when visible (popover open) OR there are active tasks
  useEffect(() => {
    if (!isConfigured || !api || isExporting) return;
    const shouldPoll = polling || activeTasks.some(t => t.status === 'pending' || t.status === 'running');
    if (!shouldPoll) return;

    const interval = setInterval(() => {
      if (!isExporting) {
        fetchActiveTasks();
        fetchAllTasks();
      }
    }, polling ? 5_000 : 10_000);

    return () => clearInterval(interval);
  }, [api, isConfigured, projectId, isExporting, polling, activeTasks.length]);

  return {
    tasks,
    activeTasks,
    loading,
    error,
    fetchActiveTasks,
    fetchAllTasks,
    cancelTask,
    getTaskById,
    activeTaskCount: activeTasks.filter(t => t.status === 'pending' || t.status === 'running').length,
    /** Call setPolling(true) when the tasks UI is visible */
    setPolling,
  };
}
