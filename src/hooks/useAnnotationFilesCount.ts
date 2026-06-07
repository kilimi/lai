import { useState, useEffect, useCallback } from 'react';

/**
 * Custom hook to get the count of annotation files for a dataset from localStorage
 */
export function useAnnotationFilesCount(datasetId: number | string) {
  const getAnnotationFilesCount = useCallback(() => {
    try {
      const savedAnnotations = localStorage.getItem(`annotations_${datasetId}`);
      if (savedAnnotations) {
        const annotationFiles = JSON.parse(savedAnnotations);
        return Array.isArray(annotationFiles) ? annotationFiles.length : 0;
      }
    } catch (error) {
      console.error('Error reading annotation files from localStorage:', error);
    }
    return 0;
  }, [datasetId]);

  const [annotationFilesCount, setAnnotationFilesCount] = useState(getAnnotationFilesCount);

  // Update annotation files count when the component mounts or dataset changes
  useEffect(() => {
    setAnnotationFilesCount(getAnnotationFilesCount());
    
    // Set up a periodic check to ensure the count stays updated
    // Reduced frequency to minimize performance impact
    const interval = setInterval(() => {
      const currentCount = getAnnotationFilesCount();
      setAnnotationFilesCount(prev => prev !== currentCount ? currentCount : prev);
    }, 30000); // Check every 30 seconds (reduced from 2s)
    
    return () => clearInterval(interval);
  }, [getAnnotationFilesCount]);

  // Listen for localStorage changes to update the count (for changes from other tabs)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === `annotations_${datasetId}`) {
        setAnnotationFilesCount(getAnnotationFilesCount());
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [datasetId, getAnnotationFilesCount]);

  return annotationFilesCount;
}
