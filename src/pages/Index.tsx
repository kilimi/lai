import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, Link } from "react-router-dom";
import { Plus, Search, Settings, Activity, Tag, Filter, Sparkles, RefreshCw, FolderOpen, ChevronRight, FolderPlus, Image as ImageIcon, Brain, BookOpen, Rocket, ArrowRight } from "lucide-react";
import { LAI_TUTORIALS_URL } from "@/constants/externalLinks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProjectCard, ProjectCardSkeleton } from "@/components/ProjectCard";
import { Project } from "@/types";
import { Navbar } from "@/components/Navbar";
import { useToast } from "@/components/ui/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStableLoading } from "@/hooks/useStableLoading";
import { useProjects } from "@/hooks/use-projects";
import {
  collectProjectTags,
  computeProjectListStats,
  filterAndSortProjects,
  type ProjectSortOrder,
} from "@/lib/projects-list";
import { cn } from "@/lib/utils";

interface QuickProjectItemProps {
  project: Project;
}

function QuickProjectItem({ project }: QuickProjectItemProps) {
  return (
    <Link 
      to={`/projects/${project.id}/datasets`}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800/50 transition-colors group"
    >
      <div className="w-8 h-8 rounded-md bg-primary/20 flex items-center justify-center flex-shrink-0">
        <FolderOpen className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
        <p className="text-xs text-muted-foreground">
          {project.datasets?.length || 0} datasets
        </p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

function EmptyOnboarding() {
  const steps = [
    {
      icon: FolderPlus,
      title: "Create your first project",
      description: "Projects organize datasets, models, and evaluations together.",
      cta: "New project",
      to: "/projects/new",
      primary: true,
    },
    {
      icon: ImageIcon,
      title: "Add a dataset",
      description: "Upload images or a video, then label them with built-in tools.",
      cta: "Watch tutorials",
      href: LAI_TUTORIALS_URL,
      external: true,
    },
    {
      icon: Brain,
      title: "Train & evaluate a model",
      description: "Run YOLO, Mask-RCNN or RT-DETR — compare results side-by-side.",
      cta: "Watch tutorials",
      href: LAI_TUTORIALS_URL,
      external: true,
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="glass-card p-10 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
        <div className="relative">
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Rocket className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-2xl font-semibold mb-2">Welcome to LAI Studio</h3>
          <p className="text-muted-foreground max-w-lg mx-auto mb-6">
            You don't have any projects yet. Follow these three steps to go from raw images to a trained model.
          </p>
          <div className="flex gap-3 justify-center flex-wrap">
            <Button asChild size="lg">
              <Link to="/projects/new" className="gap-2">
                <Plus className="w-4 h-4" />
                Create your first project
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a
                href={LAI_TUTORIALS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="gap-2 inline-flex items-center"
              >
                <BookOpen className="w-4 h-4" />
                Tutorials
              </a>
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          const cardClass =
            "group glass-card rounded-xl p-5 border border-border/50 hover:border-primary/40 transition-all hover:-translate-y-0.5";
          const content = (
            <>
              <div className="flex items-start gap-3 mb-3">
                <div className={cn(
                  "h-10 w-10 rounded-lg flex items-center justify-center flex-shrink-0",
                  step.primary ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-muted-foreground mb-0.5">Step {idx + 1}</div>
                  <h4 className="font-semibold text-foreground leading-tight">{step.title}</h4>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-4">{step.description}</p>
              <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all">
                {step.cta}
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </>
          );
          if ("external" in step && step.external) {
            return (
              <a
                key={step.title}
                href={step.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`${cardClass} block`}
              >
                {content}
              </a>
            );
          }
          return (
            <Link key={step.title} to={step.to!} className={cardClass}>
              {content}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function Index() {
  const location = useLocation();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<ProjectSortOrder>("newest");
  const [refetchTrigger, setRefetchTrigger] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const triggerZoneRef = useRef<HTMLDivElement>(null);

  const { projects, loading, error, refetch } = useProjects(refetchTrigger);
  const stableLoading = useStableLoading(loading, 250);

  const handleRefresh = () => {
    setRefetchTrigger((prev) => prev + 1);
    refetch();
    toast({
      title: "Refreshing projects...",
      description: "Loading latest data",
    });
  };

  useEffect(() => {
    if (location.state?.refetch) {
      setRefetchTrigger((prev) => prev + 1);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    if (error) {
      toast({
        title: "Error fetching projects",
        description: error || "Check your API connection settings",
        variant: "destructive",
      });
    }
  }, [error, toast]);

  const filteredAndSortedProjects = useMemo(
    () =>
      filterAndSortProjects(projects, {
        searchQuery,
        selectedTag,
        sortOrder,
      }),
    [projects, searchQuery, selectedTag, sortOrder],
  );

  const allTags = useMemo(() => collectProjectTags(projects), [projects]);
  const stats = useMemo(() => computeProjectListStats(projects), [projects]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      
      <div className="pt-16">
        <div 
          ref={triggerZoneRef}
          className="fixed left-0 top-16 w-4 h-[calc(100vh-4rem)] z-40"
          onMouseEnter={() => setSidebarVisible(true)}
        />

        <aside 
          ref={sidebarRef}
          className={cn(
            "fixed left-0 top-16 w-72 h-[calc(100vh-4rem)] border-r border-border/50 bg-background/95 backdrop-blur-sm z-50",
            "transition-transform duration-300 ease-in-out",
            sidebarVisible ? "translate-x-0" : "-translate-x-full"
          )}
          onMouseLeave={() => setSidebarVisible(false)}
        >
          <div className="p-4 h-full flex flex-col">
            <div className="mb-4 pb-4 border-b border-border/50">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">LAI Studio</h2>
                  <p className="text-xs text-muted-foreground">Quick Access</p>
                </div>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto">
              <h3 className="text-xs text-muted-foreground uppercase tracking-wider mb-3 px-1">
                Projects ({stats.totalProjects})
              </h3>
              <div className="space-y-1">
                {projects.slice(0, 8).map(project => (
                  <QuickProjectItem key={project.id} project={project} />
                ))}
                {projects.length === 0 && !loading && (
                  <p className="text-sm text-muted-foreground px-3 py-2">No projects yet</p>
                )}
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-border/50 space-y-2">
              <Button asChild variant="outline" size="sm" className="w-full justify-start gap-2">
                <Link to="/projects/new">
                  <Plus className="h-4 w-4" />
                  New Project
                </Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="w-full justify-start gap-2">
                <Link to="/settings">
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </Button>
            </div>
          </div>
        </aside>
        
        <main className="flex-1">
          <div className="container max-w-6xl mx-auto px-6 py-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl font-bold text-foreground">Projects</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {stats.totalProjects} {stats.totalProjects === 1 ? 'project' : 'projects'}
                  {' · '}
                  {stats.totalDatasets} {stats.totalDatasets === 1 ? 'dataset' : 'datasets'}
                  {' · '}
                  {stats.totalImages.toLocaleString()} images
                </p>
              </div>
              <Button asChild>
                <Link to="/projects/new" className="gap-2">
                  <Plus className="h-4 w-4" />
                  New Project
                </Link>
              </Button>
            </div>

            <div className="glass-card rounded-xl p-4 mb-6">
              <div className="flex flex-col lg:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search projects..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 h-10 bg-background/50 border-border/50"
                  />
                </div>
                
                <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as ProjectSortOrder)}>
                  <SelectTrigger className="w-[160px] h-10 bg-background/50 border-border/50">
                    <Filter className="w-4 h-4 mr-2" />
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                    <SelectItem value="name">Name (A-Z)</SelectItem>
                  </SelectContent>
                </Select>
                
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleRefresh}
                  disabled={loading}
                  className="h-10 w-10 bg-background/50 border-border/50"
                  title="Refresh projects"
                  aria-label="Refresh projects"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              
              {allTags.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/50">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Tag className="w-4 h-4 text-muted-foreground" />
                    <Button
                      variant={selectedTag === null ? "default" : "ghost"}
                      size="sm"
                      onClick={() => setSelectedTag(null)}
                      className="h-7 text-xs"
                    >
                      All
                    </Button>
                    {allTags.map(tag => (
                      <Button
                        key={tag}
                        variant={selectedTag === tag ? "default" : "ghost"}
                        size="sm"
                        onClick={() => setSelectedTag(tag)}
                        className="h-7 text-xs"
                      >
                        {tag}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {stableLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array(6).fill(0).map((_, i) => (
                  <ProjectCardSkeleton key={i} />
                ))}
              </div>
            ) : error ? (
              <Card className="glass-card p-12 text-center">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-destructive/10 flex items-center justify-center">
                  <Activity className="w-8 h-8 text-destructive" />
                </div>
                <h3 className="text-lg font-semibold mb-2 text-destructive">Connection Error</h3>
                <p className="text-muted-foreground mb-4 text-sm">{error}</p>
                <div className="flex gap-3 justify-center">
                  <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                    Try Again
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/settings">Settings</Link>
                  </Button>
                </div>
              </Card>
            ) : filteredAndSortedProjects.length === 0 ? (
              (searchQuery || selectedTag) ? (
                <Card className="glass-card p-12 text-center">
                  <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-muted/40 flex items-center justify-center">
                    <Search className="w-10 h-10 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">No matching projects</h3>
                  <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                    Try adjusting your filters or search terms.
                  </p>
                  <Button variant="outline" onClick={() => {
                    setSearchQuery("");
                    setSelectedTag(null);
                  }}>
                    Clear Filters
                  </Button>
                </Card>
              ) : (
                <EmptyOnboarding />
              )
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {filteredAndSortedProjects.length} {filteredAndSortedProjects.length === 1 ? 'project' : 'projects'}
                    </span>
                    {(searchQuery || selectedTag) && (
                      <Badge variant="secondary" className="text-xs">Filtered</Badge>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredAndSortedProjects.map((project, index) => (
                    <div key={project.id} className="animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                      <ProjectCard
                        project={project}
                        onDelete={() => setRefetchTrigger((p) => p + 1)}
                        onUpdate={() => setRefetchTrigger((p) => p + 1)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
