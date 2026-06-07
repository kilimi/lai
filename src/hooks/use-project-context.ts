import { createContext, useContext } from 'react';
import { Project, DatasetGroup } from '@/types';

interface ProjectContextType {
  project: Project | null;
  loading: boolean;
  refreshProject: () => void;
}

export const ProjectContext = createContext<ProjectContextType>({
  project: null,
  loading: false,
  refreshProject: () => {}
});

export function useProjectContext() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProjectContext must be used within a ProjectProvider');
  }
  return context;
}
