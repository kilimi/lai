import { createContext, useContext, useState, ReactNode } from 'react';

interface ExportContextType {
  isExporting: boolean;
  setIsExporting: (value: boolean) => void;
}

const ExportContext = createContext<ExportContextType | undefined>(undefined);

export function ExportProvider({ children }: { children: ReactNode }) {
  const [isExporting, setIsExporting] = useState(false);

  return (
    <ExportContext.Provider value={{ isExporting, setIsExporting }}>
      {children}
    </ExportContext.Provider>
  );
}

export function useExport() {
  const context = useContext(ExportContext);
  // Return default values if context is not available (graceful degradation)
  if (context === undefined) {
    return { isExporting: false, setIsExporting: () => {} };
  }
  return context;
}
