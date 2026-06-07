import { useState, useCallback, useRef, useEffect } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface AsyncActions<T> {
  execute: (...args: any[]) => Promise<T>;
  reset: () => void;
  setData: (data: T | null) => void;
  setError: (error: string | null) => void;
}

export interface UseAsyncOptions {
  onSuccess?: (data: any) => void;
  onError?: (error: Error) => void;
  initialLoading?: boolean;
}

/**
 * Reusable hook for managing async operations with loading/error states
 * 
 * @example
 * ```tsx
 * const { data, loading, error, execute, reset } = useAsync<User[]>();
 * 
 * const loadUsers = async () => {
 *   await execute(async () => {
 *     const response = await api.getUsers();
 *     return response.data;
 *   });
 * };
 * ```
 */
export function useAsync<T = any>(options: UseAsyncOptions = {}): AsyncState<T> & AsyncActions<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(options.initialLoading ?? false);
  const [error, setError] = useState<string | null>(null);
  
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  const execute = useCallback(async (...args: any[]): Promise<T> => {
    if (!isMountedRef.current) {
      throw new Error('Component unmounted');
    }
    
    setLoading(true);
    setError(null);
    
    try {
      // If first argument is a function, call it with remaining args
      // Otherwise, assume it's the async function itself
      const asyncFn = typeof args[0] === 'function' ? args[0] : args[0];
      const fnArgs = typeof args[0] === 'function' ? args.slice(1) : [];
      
      const result = await asyncFn(...fnArgs);
      
      if (isMountedRef.current) {
        setData(result);
        setLoading(false);
        options.onSuccess?.(result);
      }
      
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      
      if (isMountedRef.current) {
        setError(errorMessage);
        setLoading(false);
        options.onError?.(err instanceof Error ? err : new Error(errorMessage));
      }
      
      throw err;
    }
  }, [options.onSuccess, options.onError]);
  
  const reset = useCallback(() => {
    if (isMountedRef.current) {
      setData(null);
      setLoading(false);
      setError(null);
    }
  }, []);
  
  return {
    data,
    loading,
    error,
    execute,
    reset,
    setData,
    setError,
  };
}
