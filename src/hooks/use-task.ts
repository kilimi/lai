import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from './use-api';

export interface Task {
  id: number | string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  task_metadata?: Record<string, any>;
  [key: string]: any;
}

export interface UseTaskOptions {
  /** Enable automatic polling when task is running */
  poll?: boolean;
  /** Polling interval in milliseconds (default: 3000) */
  pollInterval?: number;
  /** Maximum polling duration in milliseconds (default: 300000 = 5 minutes) */
  maxPollDuration?: number;
  /** Callback when task completes */
  onComplete?: (task: Task) => void;
  /** Callback when task fails */
  onError?: (task: Task) => void;
  /** Callback when polling stops due to timeout */
  onTimeout?: () => void;
}

/**
 * Reusable hook for managing task fetching and polling
 * 
 * Features:
 * - Automatic polling for running tasks
 * - Cleanup on unmount
 * - Shared cache to reduce API calls
 * - Consistent error handling
 * - Memory leak prevention
 * 
 * @example
 * ```tsx
 * const { task, loading, error, refetch } = useTask(taskId, {
 *   poll: true,
 *   onComplete: (task) => {
 *     toast({ title: 'Task completed!' });
 *   }
 * });
 * ```
 */
export function useTask(taskId: number | string | null | undefined, options: UseTaskOptions = {}) {
  const { api } = useApi();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const isMountedRef = useRef(true);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollStartTimeRef = useRef<number>(0);
  const lastTaskIdRef = useRef<number | string | null>(null);
  
  const {
    poll = false,
    pollInterval = 3000,
    maxPollDuration = 300000, // 5 minutes
    onComplete,
    onError: onErrorCallback,
    onTimeout,
  } = options;
  
  // Cleanup function
  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);
  
  // Fetch task details
  const fetchTask = useCallback(async () => {
    if (!taskId || !api || !isMountedRef.current) return;
    
    try {
      const response = await api.getTask(Number(taskId));
      
      if (!isMountedRef.current) return;
      
      if (response.success && response.data) {
        const taskData = response.data as Task;
        setTask(taskData);
        setError(null);
        
        // Check if polling should stop
        if (poll) {
          if (taskData.status === 'completed') {
            cleanup();
            onComplete?.(taskData);
          } else if (taskData.status === 'failed' || taskData.status === 'cancelled') {
            cleanup();
            onErrorCallback?.(taskData);
          }
        }
      } else {
        throw new Error(response.error || 'Failed to fetch task');
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch task';
      setError(errorMsg);
      cleanup();
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [taskId, api, poll, onComplete, onErrorCallback, cleanup]);
  
  // Start polling
  const startPolling = useCallback(() => {
    if (!poll || !taskId || pollIntervalRef.current) return;
    
    pollStartTimeRef.current = Date.now();
    
    pollIntervalRef.current = setInterval(() => {
      if (!isMountedRef.current) {
        cleanup();
        return;
      }
      
      // Check max duration
      const elapsed = Date.now() - pollStartTimeRef.current;
      if (elapsed > maxPollDuration) {
        cleanup();
        onTimeout?.();
        return;
      }
      
      // Fetch task status
      void fetchTask();
    }, pollInterval);
  }, [poll, taskId, pollInterval, maxPollDuration, fetchTask, cleanup, onTimeout]);
  
  // Initial fetch
  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setLoading(false);
      setError(null);
      return;
    }
    
    // Reset state if task ID changes
    if (taskId !== lastTaskIdRef.current) {
      setTask(null);
      setLoading(true);
      setError(null);
      cleanup();
      lastTaskIdRef.current = taskId;
    }
    
    // Fetch immediately
    void fetchTask();
  }, [taskId, fetchTask, cleanup]);
  
  // Start/stop polling based on task status
  useEffect(() => {
    if (!poll || !task || !taskId) {
      cleanup();
      return;
    }
    
    // Start polling if task is running
    if (task.status === 'running' || task.status === 'pending') {
      startPolling();
    } else {
      cleanup();
    }
    
    return cleanup;
  }, [poll, task, taskId, startPolling, cleanup]);
  
  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);
  
  // Manual refetch
  const refetch = useCallback(() => {
    setLoading(true);
    return fetchTask();
  }, [fetchTask]);
  
  return {
    task,
    loading,
    error,
    refetch,
    cleanup,
  };
}
