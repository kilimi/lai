import { useState, useEffect } from 'react';

/**
 * Hook to provide stable loading states with minimum duration
 * Prevents flickering by ensuring loading state shows for at least minDuration
 */
export function useStableLoading(loading: boolean, minDuration: number = 300) {
  const [stableLoading, setStableLoading] = useState(loading);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);

  useEffect(() => {
    if (loading && !stableLoading) {
      // Starting to load
      setStableLoading(true);
      setLoadingStartTime(Date.now());
    } else if (!loading && stableLoading) {
      // Done loading, but check if we should wait
      const elapsed = loadingStartTime ? Date.now() - loadingStartTime : minDuration;
      
      if (elapsed >= minDuration) {
        // Enough time has passed, stop loading immediately
        setStableLoading(false);
        setLoadingStartTime(null);
      } else {
        // Wait for remaining time
        const timeout = setTimeout(() => {
          setStableLoading(false);
          setLoadingStartTime(null);
        }, minDuration - elapsed);
        
        return () => clearTimeout(timeout);
      }
    }
  }, [loading, stableLoading, loadingStartTime, minDuration]);

  return stableLoading;
}
