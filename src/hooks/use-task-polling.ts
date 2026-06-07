import { useEffect, useRef, useCallback } from "react";
import { useApi } from "./use-api";

export interface TaskPollingOptions {
  /**
   * Task ID to poll
   */
  taskId: number | string;
  
  /**
   * Callback when task completes successfully
   */
  onComplete?: (taskData: any) => void;
  
  /**
   * Callback when task fails
   */
  onError?: (error: string) => void;
  
  /**
   * Polling interval in milliseconds
   * @default 2000
   */
  interval?: number;
  
  /**
   * Maximum polling duration in milliseconds (5 minutes default)
   * @default 300000
   */
  maxDuration?: number;
  
  /**
   * Whether to start polling immediately
   * @default true
   */
  enabled?: boolean;
}

/**
 * Custom hook for polling task status with automatic cleanup
 * Prevents memory leaks by properly cleaning up intervals on unmount
 */
export function useTaskPolling({
  taskId,
  onComplete,
  onError,
  interval = 2000,
  maxDuration = 300000,
  enabled = true,
}: TaskPollingOptions) {
  const { api } = useApi();
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const maxTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  const cleanup = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (maxTimeoutRef.current) {
      clearTimeout(maxTimeoutRef.current);
      maxTimeoutRef.current = null;
    }
  }, []);

  const pollTask = useCallback(async () => {
    if (!api || !isMountedRef.current) return;

    try {
      const response = await api.getTask(Number(taskId));
      
      if (!response.success || !response.data) {
        return;
      }

      const taskData = response.data as any;

      if (!isMountedRef.current) return;

      if (taskData.status === "completed") {
        cleanup();
        onComplete?.(taskData);
      } else if (taskData.status === "failed") {
        cleanup();
        onError?.(taskData.error_message || "Task failed");
      }
    } catch (error) {
      console.error("Error polling task status:", error);
      // Don't stop polling on transient errors
    }
  }, [api, taskId, onComplete, onError, cleanup]);

  useEffect(() => {
    isMountedRef.current = true;

    if (!enabled || !taskId) {
      return;
    }

    // Start polling
    pollIntervalRef.current = setInterval(pollTask, interval);

    // Set maximum duration timeout
    maxTimeoutRef.current = setTimeout(() => {
      cleanup();
      console.warn(`Task polling stopped after ${maxDuration}ms`);
    }, maxDuration);

    // Cleanup on unmount or when dependencies change
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
  }, [enabled, taskId, interval, maxDuration, pollTask, cleanup]);

  return { cleanup };
}
