import React, { useEffect, useState, useRef } from 'react';
import { Link, useParams, useLocation, Outlet } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Navbar } from "@/components/Navbar";
import { ProjectBreadcrumb } from '@/components/ProjectBreadcrumb';
import { ProjectContext } from '@/hooks/use-project-context';
import { cn } from "@/lib/utils";
import { ArrowLeft, Database, Brain, Activity, Loader2, Download } from "lucide-react";
import { createApiClient } from '@/utils/api';
import { getApiBaseUrl } from '@/config/api';
import { Project } from '@/types';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  isActive: boolean;
}

function NavItem({ to, icon, label, count, isActive }: NavItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200",
        "hover:bg-accent/50 group",
        isActive 
          ? "bg-primary/10 border-l-4 border-primary text-primary" 
          : "text-muted-foreground hover:text-foreground border-l-4 border-transparent"
      )}
    >
      <span className={cn(
        "transition-colors",
        isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
      )}>
        {icon}
      </span>
      <span className="font-medium">{label}</span>
      {count !== undefined && (
        <span className={cn(
          "ml-auto text-xs px-2 py-0.5 rounded-full",
          isActive 
            ? "bg-primary/20 text-primary" 
            : "bg-muted text-muted-foreground"
        )}>
          {count}
        </span>
      )}
    </Link>
  );
}

export function ProjectLayout() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [datasetCount, setDatasetCount] = useState(0);
  const [modelsCount, setModelsCount] = useState<number | undefined>(undefined);
  const [evaluationsCount, setEvaluationsCount] = useState<number | undefined>(undefined);
  const [exportsCount, setExportsCount] = useState<number | undefined>(undefined);
  const mountedRef = useRef(true);

  // Single effect: fetch project summary + sidebar counts in parallel (2 lightweight SQL queries)
  useEffect(() => {
    mountedRef.current = true;
    if (!id) return;

    const client = createApiClient({ baseUrl: getApiBaseUrl() });

    const summaryP = client.getProjectSummary(id).then((res) => {
      if (!mountedRef.current) return;
      if (res.success && res.data) {
        setProject(res.data as Project);
        setDatasetCount((res.data as any).dataset_count ?? res.data.datasets?.length ?? 0);
      }
      setLoading(false);
    }).catch(() => { if (mountedRef.current) setLoading(false); });

    const countsP = client.getProjectSidebarCounts(id).then((res) => {
      if (!mountedRef.current || !res.success || !res.data) return;
      setModelsCount(res.data.models);
      setEvaluationsCount(res.data.evaluations);
      setExportsCount(res.data.exports);
    }).catch(() => {
      if (mountedRef.current) {
        setModelsCount(0);
        setEvaluationsCount(0);
        setExportsCount(0);
      }
    });

    return () => { mountedRef.current = false; };
  }, [id]);

  const refetch = () => {
    if (!id) return;
    setLoading(true);
    const client = createApiClient({ baseUrl: getApiBaseUrl() });
    client.getProjectSummary(id).then((res) => {
      if (res.success && res.data) {
        setProject(res.data as Project);
        setDatasetCount((res.data as any).dataset_count ?? res.data.datasets?.length ?? 0);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  const getActiveSection = () => {
    const path = location.pathname;
    if (path.includes('/models')) return 'models';
    if (path.includes('/evaluations')) return 'evaluations';
    if (path.includes('/exports')) return 'exports';
    return 'datasets';
  };

  const activeSection = getActiveSection();

  const contextValue = {
    project,
    loading,
    refreshProject: refetch,
  };

  return (
    <ProjectContext.Provider value={contextValue}>
      <div className="min-h-screen">
        <Navbar />
        
        <div className="pt-16 flex">
          {/* Sidebar Navigation */}
          <aside className="w-64 min-h-[calc(100vh-4rem)] border-r border-border bg-card/50 fixed left-0 top-16">
            <div className="p-4">
              {/* Project Header */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    asChild
                    className="h-8 w-8"
                  >
                    <Link to="/">
                      <ArrowLeft className="h-4 w-4" />
                    </Link>
                  </Button>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Project</span>
                </div>
                <h2 className="text-lg font-semibold text-foreground truncate px-2">
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    project?.name || 'Unknown Project'
                  )}
                </h2>
              </div>
              
              {/* Navigation Links */}
              <nav className="space-y-1">
                <NavItem
                  to={`/projects/${id}/datasets`}
                  icon={<Database className="h-5 w-5" />}
                  label="Datasets"
                  count={datasetCount}
                  isActive={activeSection === 'datasets'}
                />
                <NavItem
                  to={`/projects/${id}/models`}
                  icon={<Brain className="h-5 w-5" />}
                  label="Models"
                  count={modelsCount}
                  isActive={activeSection === 'models'}
                />
                <NavItem
                  to={`/projects/${id}/evaluations`}
                  icon={<Activity className="h-5 w-5" />}
                  label="Evaluations"
                  count={evaluationsCount}
                  isActive={activeSection === 'evaluations'}
                />
                <NavItem
                  to={`/projects/${id}/exports`}
                  icon={<Download className="h-5 w-5" />}
                  label="Convert"
                  count={exportsCount}
                  isActive={activeSection === 'exports'}
                />
              </nav>
            </div>
          </aside>
          
          {/* Main Content */}
          <main className="flex-1 ml-64">
            <div className="container max-w-6xl mx-auto px-6 py-6">
              {/* Breadcrumb */}
              <ProjectBreadcrumb 
                projectName={project?.name || null}
                isLoading={loading}
              />
              
              {/* Page Content - Rendered via Outlet */}
              <Outlet context={{ project, loading, refreshProject: refetch }} />
            </div>
          </main>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}
