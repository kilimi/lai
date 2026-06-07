import { Link, useLocation, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Settings, Sparkles, Sun, Moon, Cpu, Loader2, BookOpen } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import { TasksPopover } from "./TasksPopover";
import { useTheme } from "./ThemeProvider";
import { useApi } from "@/hooks/use-api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { LAI_TUTORIALS_URL } from "@/constants/externalLinks";

type GpuStatus = {
  has_gpu: boolean;
  gpu_count: number;
  gpus: Array<{ name: string; memory_used_mb: number; memory_total_mb: number; utilization_percent: number }>;
  memory_used_mb: number;
  memory_total_mb: number;
  source?: string;
  status?: string;
};

export function Navbar() {
  const location = useLocation();
  const pathname = location.pathname;
  const params = useParams<{ projectId?: string; id?: string }>();
  // Use projectId only when it's actually a project: /projects/:projectId/datasets/... has projectId.
  // On /datasets/:id the param "id" is the dataset id — never use it as projectId or we fetch wrong tasks.
  // On /projects/:id (project layout) the param "id" is the project id.
  const projectIdNum = params.projectId
    ? parseInt(params.projectId, 10)
    : pathname.startsWith("/datasets/")
      ? undefined
      : params.id
        ? parseInt(params.id, 10)
        : undefined;
  const [scrolled, setScrolled] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const { api } = useApi();
  const [gpuStatus, setGpuStatus] = useState<GpuStatus | null>(null);
  const [gpuLoading, setGpuLoading] = useState(false);
  const [gpuPopoverOpen, setGpuPopoverOpen] = useState(false);
  const gpuFetchedOnce = useRef(false);

  const fetchGpuStatus = useCallback(async () => {
    if (!api) return;
    setGpuLoading(true);
    try {
      const res = await api.getGpuStatus();
      const payload = res.data ?? (res as unknown as { has_gpu?: boolean; gpus?: unknown[] });
      if (payload && typeof (payload as { has_gpu?: boolean }).has_gpu === "boolean") {
        setGpuStatus(payload as GpuStatus);
      } else {
        setGpuStatus(null);
      }
    } catch {
      setGpuStatus(null);
    } finally {
      setGpuLoading(false);
    }
  }, [api]);

  // Fetch GPU only when popover opens (first open fetches once, then polls every 15s).
  // Deliberately NOT fetching on mount — the API response arriving seconds later would
  // update the button text, which becomes the LCP candidate on content-sparse pages.
  useEffect(() => {
    if (!api || !gpuPopoverOpen) return;
    if (!gpuFetchedOnce.current) {
      gpuFetchedOnce.current = true;
    }
    fetchGpuStatus();
    const interval = setInterval(fetchGpuStatus, 15_000);
    return () => clearInterval(interval);
  }, [api, gpuPopoverOpen, fetchGpuStatus]);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 10);
    };
    
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const formatMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 h-16 transition-all duration-300",
        scrolled ? "nav-blur" : "bg-transparent"
      )}
    >
      <div className="flex h-full items-center justify-between w-full px-4">
        <div className="flex items-center gap-6">
          <Link 
            to="/" 
            className="flex items-center gap-3 text-xl font-bold tracking-tight group"
          >
            <div className="relative">
              <Sparkles className="w-6 h-6 text-primary animate-pulse-soft group-hover:animate-spin transition-all duration-300" />
              <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </div>
            <span className="bg-gradient-to-r from-primary via-accent to-secondary bg-clip-text text-transparent group-hover:from-accent group-hover:via-primary group-hover:to-secondary transition-all duration-300">
              LAI
            </span>
          </Link>
        </div>
        
        <div className="flex items-center gap-2">
          <TasksPopover />

          <Popover open={gpuPopoverOpen} onOpenChange={setGpuPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 px-2.5 text-xs font-medium"
                title="GPU resource usage"
              >
                {gpuLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Cpu className="h-3.5 w-3.5" />
                )}
                {gpuStatus?.has_gpu ? (
                  <span className="hidden sm:inline">
                    {formatMb(gpuStatus.memory_used_mb)} / {formatMb(gpuStatus.memory_total_mb)}
                  </span>
                ) : gpuStatus && !gpuStatus.has_gpu ? (
                  <span className="hidden sm:inline text-muted-foreground">No GPU</span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="end">
              <div className="p-3 border-b">
                <p className="text-sm font-medium">GPU resources</p>
                <p className="text-xs text-muted-foreground">
                  {gpuStatus?.has_gpu
                    ? `${gpuStatus.gpu_count} GPU${gpuStatus.gpu_count > 1 ? "s" : ""} · ${formatMb(gpuStatus.memory_used_mb)} / ${formatMb(gpuStatus.memory_total_mb)} used`
                    : gpuStatus?.status === "unknown"
                      ? "GPU status unavailable"
                      : "No GPU detected"}
                </p>
              </div>
              {gpuStatus?.gpus && gpuStatus.gpus.length > 0 && (
                <div className="p-3 space-y-3 max-h-64 overflow-y-auto">
                  {gpuStatus.gpus.map((gpu, i) => {
                    const pct = gpu.memory_total_mb > 0 ? (gpu.memory_used_mb / gpu.memory_total_mb) * 100 : 0;
                    return (
                      <div key={i} className="space-y-1.5">
                        <p className="text-xs font-medium truncate" title={gpu.name}>
                          GPU {i + 1}: {gpu.name}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Progress value={pct} className="h-1.5 flex-1" />
                          <span>{formatMb(gpu.memory_used_mb)} / {formatMb(gpu.memory_total_mb)}</span>
                        </div>
                        {gpu.utilization_percent > 0 && (
                          <p className="text-xs text-muted-foreground">Utilization: {gpu.utilization_percent}%</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
          
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 px-2.5 text-xs font-medium hidden sm:inline-flex"
            asChild
          >
            <a
              href={LAI_TUTORIALS_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Tutorials and workflow guides"
            >
              <BookOpen className="h-3.5 w-3.5" />
              Tutorials
            </a>
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 sm:hidden"
            asChild
          >
            <a
              href={LAI_TUTORIALS_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Tutorials"
            >
              <BookOpen className="h-4 w-4" />
            </a>
          </Button>

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            asChild
          >
            <Link to="/settings">
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
