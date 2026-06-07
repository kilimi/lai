
import { useState, useEffect } from 'react';
import { LayoutType } from '@/components/LayoutControls';

export type DatasetUiMode = 'default' | 'advanced';

interface DatasetSettings {
  imagesPerPage: number;
  imageSize: number;
  layout: LayoutType;
  sliderPosition: number; // Add slider position (0-100)
  /** default: simplified UI. advanced: full tools. */
  mode: DatasetUiMode;
}

const DEFAULT_SETTINGS: DatasetSettings = {
  imagesPerPage: 20,
  imageSize: 160,
  layout: 'horizontal',
  sliderPosition: 50, // Default 50/50 split
  mode: 'default',
};

/** Optional overrides when no saved settings exist (e.g. classification view uses larger default image size) */
export type DatasetSettingsOverrides = Partial<Pick<DatasetSettings, 'imageSize'>>;

export function useDatasetSettings(datasetId: string, overrides?: DatasetSettingsOverrides) {
  const defaults = overrides ? { ...DEFAULT_SETTINGS, ...overrides } : DEFAULT_SETTINGS;
  const [settings, setSettings] = useState<DatasetSettings>(defaults);
  const [isLoaded, setIsLoaded] = useState(false);
  
  // Load settings from localStorage on mount and when datasetId changes
  useEffect(() => {
    console.log('useDatasetSettings effect triggered with datasetId:', datasetId);
    
    if (!datasetId || datasetId.trim() === '') {
      console.log('No valid datasetId, using defaults');
      setSettings(defaults);
      setIsLoaded(false);
      return;
    }
    
    const storageKey = `dataset-settings-${datasetId}`;
    const storedSettings = localStorage.getItem(storageKey);
    
    console.log('Loading dataset settings for:', datasetId);
    console.log('Storage key:', storageKey);
    console.log('Stored settings raw:', storedSettings);
    
    if (storedSettings) {
      try {
        const parsed = JSON.parse(storedSettings);
        const mergedSettings: DatasetSettings = { ...defaults, ...parsed };
        if (mergedSettings.mode !== 'default' && mergedSettings.mode !== 'advanced') {
          mergedSettings.mode = defaults.mode;
        }
        console.log('Parsed settings:', parsed);
        console.log('Merged settings:', mergedSettings);
        setSettings(mergedSettings);
        setIsLoaded(true);
      } catch (error) {
        console.warn('Failed to parse stored dataset settings:', error);
        setSettings(defaults);
        setIsLoaded(true);
      }
    } else {
      console.log('No stored settings found, using defaults');
      setSettings(defaults);
      setIsLoaded(true);
    }
  }, [datasetId]);
  
  // Save settings to localStorage whenever they change
  const updateSettings = (newSettings: Partial<DatasetSettings>) => {
    if (!datasetId || datasetId.trim() === '') {
      console.warn('Cannot save settings: no valid datasetId');
      return;
    }
    
    const updatedSettings = { ...settings, ...newSettings };
    console.log('Updating settings for datasetId:', datasetId);
    console.log('Settings update:', newSettings);
    console.log('New full settings:', updatedSettings);
    
    setSettings(updatedSettings);
    
    const storageKey = `dataset-settings-${datasetId}`;
    localStorage.setItem(storageKey, JSON.stringify(updatedSettings));
    console.log('Settings saved to localStorage with key:', storageKey);
    console.log('Verification - localStorage now contains:', localStorage.getItem(storageKey));
  };
  
  return {
    settings,
    isLoaded,
    updateImagesPerPage: (value: number) => updateSettings({ imagesPerPage: value }),
    updateImageSize: (value: number) => updateSettings({ imageSize: value }),
    updateLayout: (value: LayoutType) => updateSettings({ layout: value }),
    updateSliderPosition: (value: number) => updateSettings({ sliderPosition: value }),
    updateMode: (value: DatasetUiMode) => updateSettings({ mode: value }),
  };
}
