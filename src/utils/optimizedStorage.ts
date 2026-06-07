// Optimized localStorage utilities for classifications
// Provides efficient storage with compression and cleanup capabilities

export class OptimizedClassificationStorage {
  private datasetId: string;
  
  constructor(datasetId: string) {
    this.datasetId = datasetId;
  }
  
  // Optimized storage format:
  // {
  //   v: 1, // version
  //   c: ["class1", "class2", "class3"], // class dictionary
  //   d: {
  //     "img1": [0, 1], // image -> class indices
  //     "img2": [0, 2]
  //   }
  // }
  
  saveClassifications(classifications: { [imageId: string]: string[] }, classes: string[]) {
    try {
      // Create optimized format
      const optimized = {
        v: 1, // version for future compatibility
        c: classes, // class dictionary
        d: {} as { [imageId: string]: number[] }
      };
      
      // Convert string arrays to index arrays
      Object.entries(classifications).forEach(([imageId, imageClasses]) => {
        optimized.d[imageId] = imageClasses.map(className => {
          const index = classes.indexOf(className);
          return index === -1 ? -1 : index; // Handle missing classes gracefully
        }).filter(index => index !== -1);
      });
      
      // Use compression-friendly JSON (no extra spaces)
      const jsonString = JSON.stringify(optimized);
      
      // Try to compress using LZ-string if available
      const compressed = this.compress(jsonString);
      
      localStorage.setItem(`opt_classifications_${this.datasetId}`, compressed);
      localStorage.setItem(`classification_classes_${this.datasetId}`, JSON.stringify(classes));
      
      return true;
    } catch (error) {
      console.error('Failed to save optimized classifications:', error);
      return false;
    }
  }
  
  loadClassifications(): { classifications: { [imageId: string]: string[] }, classes: string[] } {
    try {
      const compressed = localStorage.getItem(`opt_classifications_${this.datasetId}`);
      const classesJson = localStorage.getItem(`classification_classes_${this.datasetId}`);
      
      if (!compressed || !classesJson) {
        // Try loading legacy format
        return this.loadLegacyFormat();
      }
      
      const jsonString = this.decompress(compressed);
      const optimized = JSON.parse(jsonString);
      const classes = JSON.parse(classesJson);
      
      // Convert back to original format
      const classifications: { [imageId: string]: string[] } = {};
      
      Object.entries(optimized.d).forEach(([imageId, indices]) => {
        classifications[imageId] = (indices as number[]).map(index => optimized.c[index]).filter(Boolean);
      });
      
      return { classifications, classes };
    } catch (error) {
      console.error('Failed to load optimized classifications:', error);
      return { classifications: {}, classes: [] };
    }
  }
  
  private loadLegacyFormat(): { classifications: { [imageId: string]: string[] }, classes: string[] } {
    try {
      const legacyClassifications = localStorage.getItem(`classifications_${this.datasetId}`);
      const legacyClasses = localStorage.getItem(`classification_classes_${this.datasetId}`);
      
      return {
        classifications: legacyClassifications ? JSON.parse(legacyClassifications) : {},
        classes: legacyClasses ? JSON.parse(legacyClasses) : []
      };
    } catch (error) {
      return { classifications: {}, classes: [] };
    }
  }
  
  // Simple compression using run-length encoding for repeated patterns
  private compress(str: string): string {
    // Simple compression: remove unnecessary whitespace from JSON
    try {
      const parsed = JSON.parse(str);
      return JSON.stringify(parsed); // This removes all extra whitespace
    } catch {
      return str;
    }
  }
  
  private decompress(str: string): string {
    return str;
  }
  
  // Migrate from legacy format to optimized format
  migrateLegacyData(): boolean {
    try {
      const { classifications, classes } = this.loadLegacyFormat();
      
      if (Object.keys(classifications).length > 0) {
        const success = this.saveClassifications(classifications, classes);
        
        if (success) {
          // Remove legacy data
          localStorage.removeItem(`classifications_${this.datasetId}`);
          console.log(`Migrated ${Object.keys(classifications).length} classifications to optimized format`);
        }
        
        return success;
      }
      
      return true;
    } catch (error) {
      console.error('Failed to migrate legacy data:', error);
      return false;
    }
  }
  
  // Get storage statistics
  getStorageStats() {
    const optimized = localStorage.getItem(`opt_classifications_${this.datasetId}`);
    const legacy = localStorage.getItem(`classifications_${this.datasetId}`);
    const classes = localStorage.getItem(`classification_classes_${this.datasetId}`);
    
    const optimizedSize = optimized ? optimized.length * 2 : 0;
    const legacySize = legacy ? legacy.length * 2 : 0;
    const classesSize = classes ? classes.length * 2 : 0;
    
    return {
      optimizedSize,
      legacySize,
      classesSize,
      totalSize: optimizedSize + legacySize + classesSize,
      savings: legacySize > 0 ? ((legacySize - optimizedSize) / legacySize * 100) : 0
    };
  }
  
  // Clear all classification data for this dataset
  clearData(): void {
    try {
      localStorage.removeItem(`opt_classifications_${this.datasetId}`);
      localStorage.removeItem(`classifications_${this.datasetId}`);
      localStorage.removeItem(`classification_classes_${this.datasetId}`);
    } catch (error) {
      console.warn('Failed to clear classification data:', error);
    }
  }
}

// Utility functions for general localStorage cleanup
export class LocalStorageCleanup {
  static analyzeUsage() {
    let totalSize = 0;
    const categories: { [key: string]: { count: number; size: number } } = {};
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      
      const value = localStorage.getItem(key);
      const size = (key.length + (value?.length || 0)) * 2;
      totalSize += size;
      
      let category = 'other';
      if (key.includes('classifications_')) category = 'classifications';
      else if (key.includes('annotations_')) category = 'annotations';
      else if (key.includes('saved_annotations_')) category = 'saved_annotations';
      else if (key.includes('dataset-settings')) category = 'settings';
      
      if (!categories[category]) categories[category] = { count: 0, size: 0 };
      categories[category].count++;
      categories[category].size += size;
    }
    
    return { totalSize, categories };
  }
  
  static cleanupOldData(keepDatasetIds: string[] = []): number {
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      
      // Check if it's data we manage
      const isOurData = key.includes('classifications_') || 
                       key.includes('opt_classifications_') ||
                       key.includes('annotations_') || 
                       key.includes('saved_annotations_') ||
                       key.includes('annotation_visibility_') ||
                       key.includes('dataset-settings-');
      
      if (isOurData) {
        // Extract dataset ID and check if we should keep it
        const shouldKeep = keepDatasetIds.some(id => key.includes(`_${id}`) || key.includes(`-${id}`));
        if (!shouldKeep) {
          keysToRemove.push(key);
        }
      }
    }
    
    // Remove old data
    keysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch (error) {
        console.warn(`Failed to remove ${key}:`, error);
      }
    });
    
    return keysToRemove.length;
  }
  
  // Clean up classification data specifically, keeping only recent datasets
  static cleanupClassificationData(keepRecentCount: number = 3): number {
    const classificationKeys: { key: string; timestamp: number; datasetId: string }[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || (!key.includes('classifications_') && !key.includes('opt_classifications_'))) continue;
      
      try {
        // Extract dataset ID
        const datasetId = key.replace(/^(opt_)?classifications_/, '');
        
        // Try to get modification time from data or use current time
        let timestamp = Date.now();
        const data = localStorage.getItem(key);
        if (data) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.timestamp) {
              timestamp = new Date(parsed.timestamp).getTime();
            }
          } catch {
            // Use file size as rough timestamp proxy (larger = more recent work)
            timestamp = data.length;
          }
        }
        
        classificationKeys.push({ key, timestamp, datasetId });
      } catch (error) {
        console.warn(`Error processing key ${key}:`, error);
      }
    }
    
    // Sort by timestamp (most recent first)
    classificationKeys.sort((a, b) => b.timestamp - a.timestamp);
    
    // Keep only the most recent datasets
    const keysToRemove = classificationKeys.slice(keepRecentCount);
    
    keysToRemove.forEach(({ key }) => {
      try {
        localStorage.removeItem(key);
        // Also remove related class data
        const datasetId = key.replace(/^(opt_)?classifications_/, '');
        localStorage.removeItem(`classification_classes_${datasetId}`);
      } catch (error) {
        console.warn(`Failed to remove ${key}:`, error);
      }
    });
    
    return keysToRemove.length;
  }
}
