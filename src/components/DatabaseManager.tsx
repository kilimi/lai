import { useState, useRef, useEffect, useCallback } from "react";
import { Download, Upload, Database, AlertTriangle, Info, FileArchive, Trash2, Skull, ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import { useExport } from "@/contexts/ExportContext";
import { useTask } from "@/hooks/use-task";
import { API_CONFIG } from "@/config/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/use-api";

interface DatabaseInfo {
  database_info: {
    projects: number;
    datasets: number;
    images: number;
    annotations: number;
    annotation_files: number;
    annotation_classes: number;
    image_collections: number;
    tasks: number;
    augmentations: number;
    dataset_groups: number;
    total_records: number;
  };
  timestamp: string;
}

interface DatabaseManagerProps {
  showExport?: boolean;
  showImport?: boolean;
  showClear?: boolean;
  showInfo?: boolean;
}

export function DatabaseManager({ 
  showExport = true, 
  showImport = true, 
  showClear = false, 
  showInfo = true 
}: DatabaseManagerProps = {}) {
  const { api } = useApi();
  const { toast } = useToast();
  const { setIsExporting: setGlobalExporting } = useExport();
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [databaseInfo, setDatabaseInfo] = useState<DatabaseInfo | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [importMode, setImportMode] = useState<'json' | 'zip'>('zip');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Selective export state
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Set<number>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [selectedDatasets, setSelectedDatasets] = useState<Set<number>>(new Set());
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("select");
  const [linuxExpanded, setLinuxExpanded] = useState(false);
  const [windowsExpanded, setWindowsExpanded] = useState(false);
  const [exportTaskId, setExportTaskId] = useState<number | null>(null);
  const [exportStage, setExportStage] = useState<string>("");

  const handleExportComplete = useCallback((task: { id: number | string }) => {
    const url = `${API_CONFIG.baseUrl}/database/export/download/${task.id}`;
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast({
      title: "Export ready",
      description: "Download started. Check your browser downloads folder.",
    });
    setShowExportDialog(false);
    setIsExporting(false);
    setGlobalExporting(false);
    setExportTaskId(null);
    setExportProgress(0);
    setExportStage("");
  }, [toast, setGlobalExporting]);

  const handleExportError = useCallback((task: { error_message?: string; task_metadata?: Record<string, unknown> }) => {
    toast({
      title: "Export failed",
      description: task.error_message || "Database export failed",
      variant: "destructive",
    });
    setIsExporting(false);
    setGlobalExporting(false);
    setExportTaskId(null);
    setExportProgress(0);
    setExportStage("");
  }, [toast, setGlobalExporting]);

  const { task: activeExportTask } = useTask(exportTaskId, {
    poll: exportTaskId != null,
    pollInterval: 3000,
    maxPollDuration: 86_400_000,
    onComplete: handleExportComplete,
    onError: handleExportError,
  });

  useEffect(() => {
    if (!activeExportTask) return;
    if (typeof activeExportTask.progress === "number") {
      setExportProgress(Math.round(activeExportTask.progress));
    }
    const stage = activeExportTask.task_metadata?.stage;
    if (typeof stage === "string") {
      setExportStage(stage);
    }
  }, [activeExportTask]);

  // Handle dialog close - cancel export if in progress
  const handleDialogClose = (open: boolean) => {
    if (!open && isExporting) {
      // Cancel export if dialog is being closed during export
      handleCancelExport();
    }
    setShowExportDialog(open);
  };

  const fetchDatabaseInfo = async () => {
    if (!api) return;
    
    try {
      const response = await api.getDatabaseInfo();
      if (response.success && response.data) {
        setDatabaseInfo(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch database info:', error);
    }
  };

  const fetchProjectsWithDatasets = async () => {
    if (!api) return;
    
    setIsLoadingProjects(true);
    try {
      // Use ultra-lightweight endpoint that only returns IDs and names
      const response = await api.getProjectsNamesOnly();
      if (response.success && response.data) {
        setProjects(response.data);
        // Start with nothing selected - user must explicitly choose
        setSelectedProjects(new Set());
        setSelectedDatasets(new Set());
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const handleExportDatabase = async (includeFiles: boolean = true) => {
    if (!api) {
      toast({
        title: "Error",
        description: "API not available",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);
    setGlobalExporting(true);
    setExportProgress(0);
    setExportStage("queued");

    const projectIds = Array.from(selectedProjects);
    const datasetIds = Array.from(selectedDatasets);

    try {
      const response = await api.startDatabaseExport({
        include_files: includeFiles,
        project_ids: projectIds.length > 0 ? projectIds : undefined,
        dataset_ids: datasetIds.length > 0 ? datasetIds : undefined,
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to start export");
      }
      const taskId =
        (response as { task_id?: number }).task_id ?? response.data?.task_id;
      if (!taskId) {
        throw new Error("Failed to start export (no task id)");
      }

      setExportTaskId(taskId);
      setExportProgress(5);
      toast({
        title: "Export started",
        description: includeFiles
          ? "Building archive on the server. Progress updates below; download starts when complete."
          : "Exporting database JSON on the server. Download starts when complete.",
      });
    } catch (error) {
      console.error("Export failed:", error);
      toast({
        title: "Export Failed",
        description: error instanceof Error ? error.message : "Failed to start export",
        variant: "destructive",
      });
      setIsExporting(false);
      setGlobalExporting(false);
      setExportProgress(0);
      setExportStage("");
    }
  };

  const handleCancelExport = () => {
    setExportTaskId(null);
    setIsExporting(false);
    setGlobalExporting(false);
    setExportProgress(0);
    setExportStage("");
  };

  const handleImportDatabase = async (file: File) => {
    if (!api) {
      toast({
        title: "Error",
        description: "API not available",
        variant: "destructive",
      });
      return;
    }

    setIsImporting(true);
    try {
      const response = await api.importDatabase(file);
      
      if (response.success) {
        toast({
          title: "Import Successful",
          description: response.data?.message || "Database imported successfully",
        });
        setShowImportDialog(false);
        // Refresh the page to show new data
        window.location.reload();
      } else {
        throw new Error(response.error || "Import failed");
      }
    } catch (error) {
      console.error('Import failed:', error);
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : "Failed to import database",
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Validate file type
      const isValidFile = file.name.endsWith('.json') || file.name.endsWith('.zip');
      if (!isValidFile) {
        toast({
          title: "Invalid File",
          description: "Please select a JSON or ZIP file",
          variant: "destructive",
        });
        return;
      }

      // Set import mode based on file type
      setImportMode(file.name.endsWith('.zip') ? 'zip' : 'json');
      
      // Show confirmation dialog or import directly
      handleImportDatabase(file);
    }
  };

  const handleClearDatabase = async () => {
    if (!api) {
      toast({
        title: "Error",
        description: "API not available",
        variant: "destructive",
      });
      return;
    }

    if (clearConfirmText !== "DELETE ALL DATA") {
      toast({
        title: "Confirmation Required",
        description: "Please type 'DELETE ALL DATA' to confirm",
        variant: "destructive",
      });
      return;
    }

    setIsClearing(true);
    try {
      const response = await api.clearDatabase();
      
      if (response.success) {
        toast({
          title: "Database Cleared",
          description: `Successfully deleted ${response.data?.total_records_deleted || 0} records and ${response.data?.files_removed || 0} files`,
        });
        setShowClearDialog(false);
        setClearConfirmText("");
        // Refresh the page to show empty state
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        throw new Error(response.error || "Clear operation failed");
      }
    } catch (error) {
      console.error('Clear failed:', error);
      toast({
        title: "Clear Failed",
        description: error instanceof Error ? error.message : "Failed to clear database",
        variant: "destructive",
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <>
      {/* Blocking overlay during export */}
      {isExporting && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center">
          <div className="bg-background p-6 rounded-lg shadow-lg max-w-md w-full mx-4 border-2 border-primary">
            <div className="text-center space-y-4">
              <div className="flex items-center justify-center gap-3">
                <Database className="w-8 h-8 text-primary animate-pulse" />
                <div className="text-lg font-semibold">Exporting Database</div>
              </div>
              <div className="space-y-2">
                <div className="w-full bg-secondary rounded-full h-2.5">
                  <div 
                    className="bg-primary h-2.5 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
                <div className="text-sm text-muted-foreground">
                  {exportProgress === 100 ? "100%" : `${exportProgress}%`}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {exportStage === "queued" || exportStage === "preparing"
                  ? "Waiting for worker to start..."
                  : exportStage === "database"
                  ? "Exporting database records..."
                  : exportStage === "files"
                  ? `Adding files to archive${activeExportTask?.task_metadata?.files_total
                      ? ` (${activeExportTask.task_metadata.files_done ?? 0}/${activeExportTask.task_metadata.files_total})`
                      : ""}...`
                  : exportProgress < 100
                  ? "Export in progress..."
                  : "Export complete! Check your browser downloads."}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancelExport}
                className="w-full"
              >
                Cancel Export
              </Button>
            </div>
          </div>
        </div>
      )}
      
      <div className="flex items-center gap-3">
        {/* Export Dialog */}
        {showExport && (
          <Dialog 
            open={showExportDialog} 
            onOpenChange={(open) => {
              // Prevent closing during export
              if (!open && isExporting) {
                return;
              }
              handleDialogClose(open);
            }}
          >
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className="flex items-center gap-2"
            onClick={() => {
              fetchDatabaseInfo();
              fetchProjectsWithDatasets();
            }}
          >
            <Download className="w-4 h-4" />
            Export Database
          </Button>
        </DialogTrigger>
        <DialogContent 
          className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
          onInteractOutside={(e) => {
            // Prevent closing during export
            if (isExporting) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            // Prevent closing during export
            if (isExporting) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Export Database
            </DialogTitle>
            <DialogDescription>
              Export selected projects and datasets. Choose between quick metadata export or full archive.
            </DialogDescription>
          </DialogHeader>
          
          {!isExporting ? (
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="select">1. Select Data</TabsTrigger>
                <TabsTrigger value="export">2. Export Method</TabsTrigger>
                <TabsTrigger value="manual">Manual Copy</TabsTrigger>
              </TabsList>
              
              <TabsContent value="select" className="flex-1 min-h-0 mt-4">
                <div className="space-y-3">
                  {databaseInfo && (
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div className="flex flex-col items-center p-2 bg-muted rounded">
                        <span className="text-xs text-muted-foreground">Projects</span>
                        <span className="text-lg font-semibold">{databaseInfo.database_info.projects}</span>
                      </div>
                      <div className="flex flex-col items-center p-2 bg-muted rounded">
                        <span className="text-xs text-muted-foreground">Datasets</span>
                        <span className="text-lg font-semibold">{databaseInfo.database_info.datasets}</span>
                      </div>
                      <div className="flex flex-col items-center p-2 bg-muted rounded">
                        <span className="text-xs text-muted-foreground">Images</span>
                        <span className="text-lg font-semibold">{databaseInfo.database_info.images.toLocaleString()}</span>
                      </div>
                      <div className="flex flex-col items-center p-2 bg-muted rounded">
                        <span className="text-xs text-muted-foreground">Annotations</span>
                        <span className="text-lg font-semibold">{databaseInfo.database_info.annotations.toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                  
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Select Projects & Datasets</h3>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const allProjectIds = new Set(projects.map((p: any) => p.id));
                          const allDatasetIds = new Set(
                            projects.flatMap((p: any) => p.datasets?.map((d: any) => d.id) || [])
                          );
                          setSelectedProjects(allProjectIds);
                          setSelectedDatasets(allDatasetIds);
                        }}
                      >
                        Select All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedProjects(new Set());
                          setSelectedDatasets(new Set());
                        }}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                  
                  <ScrollArea className="h-[340px] border rounded-lg p-3">{isLoadingProjects ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-sm text-muted-foreground">Loading projects...</div>
                      </div>
                    ) : projects.length === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-sm text-muted-foreground">No projects found</div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {projects.map((project) => {
                          const isProjectExpanded = expandedProjects.has(project.id);
                          const projectDatasets = project.datasets || [];
                          const allDatasetsSelected = projectDatasets.every((d: any) => selectedDatasets.has(d.id));
                          
                          return (
                            <div key={project.id} className="space-y-1">
                              <div className="flex items-center space-x-2 py-1.5 px-2 hover:bg-muted/50 rounded">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 w-5 p-0"
                                  onClick={() => {
                                    const newExpanded = new Set(expandedProjects);
                                    if (isProjectExpanded) {
                                      newExpanded.delete(project.id);
                                    } else {
                                      newExpanded.add(project.id);
                                    }
                                    setExpandedProjects(newExpanded);
                                  }}
                                >
                                  {isProjectExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                <Checkbox
                                  checked={selectedProjects.has(project.id) && allDatasetsSelected}
                                  onCheckedChange={(checked) => {
                                    const newProjects = new Set(selectedProjects);
                                    const newDatasets = new Set(selectedDatasets);
                                    
                                    if (checked) {
                                      newProjects.add(project.id);
                                      projectDatasets.forEach((d: any) => newDatasets.add(d.id));
                                    } else {
                                      newProjects.delete(project.id);
                                      projectDatasets.forEach((d: any) => newDatasets.delete(d.id));
                                    }
                                    
                                    setSelectedProjects(newProjects);
                                    setSelectedDatasets(newDatasets);
                                  }}
                                />
                                <span className="text-sm font-medium flex-1">{project.name}</span>
                                <Badge variant="outline" className="text-xs">
                                  {projectDatasets.length}
                                </Badge>
                              </div>
                              
                              {isProjectExpanded && projectDatasets.length > 0 && (
                                <div className="ml-7 space-y-0.5">
                                  {projectDatasets.map((dataset: any) => (
                                    <div key={dataset.id} className="flex items-center space-x-2 py-1 px-2 hover:bg-muted/30 rounded">
                                      <Checkbox
                                        checked={selectedDatasets.has(dataset.id)}
                                        onCheckedChange={(checked) => {
                                          const newDatasets = new Set(selectedDatasets);
                                          if (checked) {
                                            newDatasets.add(dataset.id);
                                          } else {
                                            newDatasets.delete(dataset.id);
                                          }
                                          setSelectedDatasets(newDatasets);
                                        }}
                                      />
                                      <span className="text-sm text-muted-foreground flex-1">{dataset.name}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {dataset.image_count || 0} img
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                  
                  <div className="flex justify-between items-center pt-2">
                    <div className="text-sm text-muted-foreground">
                      {selectedProjects.size} projects, {selectedDatasets.size} datasets selected
                    </div>
                    <Button 
                      onClick={() => setActiveTab("export")}
                      disabled={selectedProjects.size === 0}
                    >
                      Next: Choose Export Method
                    </Button>
                  </div>
                </div>
              </TabsContent>
              
              <TabsContent value="export" className="flex-1 space-y-4 mt-4">
                {databaseInfo && databaseInfo.database_info.images > 1000 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
                    <div className="flex gap-2">
                      <AlertTriangle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-medium text-yellow-600">Large Dataset ({databaseInfo.database_info.images.toLocaleString()} images)</p>
                        <p className="text-muted-foreground text-xs mt-1">
                          Consider <strong>Database Only</strong> export + manual file copy for best performance
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                
                <div className="grid gap-3">
                  <div 
                    className="border-2 rounded-lg p-4 cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleExportDatabase(false)}
                  >
                    <div className="flex items-start gap-3">
                      <Database className="w-5 h-5 text-primary mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-medium">Database Only (JSON)</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                          Fast export of metadata, annotations, and structure. Images copied separately.
                        </p>
                        <div className="flex gap-2 mt-2">
                          <Badge variant="secondary" className="text-xs">~1-5 seconds</Badge>
                          <Badge variant="secondary" className="text-xs">Recommended</Badge>
                        </div>
                      </div>
                      <Button>Export</Button>
                    </div>
                  </div>
                  
                  <div 
                    className="border-2 rounded-lg p-4 cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleExportDatabase(true)}
                  >
                    <div className="flex items-start gap-3">
                      <FileArchive className="w-5 h-5 text-primary mt-0.5" />
                      <div className="flex-1">
                        <h3 className="font-medium">Complete Archive (ZIP)</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                          Includes database + all image files. The browser downloads directly
                          (recommended for large datasets: use Database Only + manual copy instead).
                        </p>
                        <div className="flex gap-2 mt-2">
                          <Badge variant="outline" className="text-xs">Minutes to hours</Badge>
                          <Badge variant="outline" className="text-xs">For small datasets</Badge>
                        </div>
                      </div>
                      <Button variant="outline">Export</Button>
                    </div>
                  </div>
                </div>
                
                <Button variant="ghost" onClick={() => setActiveTab("manual")} className="w-full">
                  <Info className="w-4 h-4 mr-2" />
                  View Manual Copy Instructions
                </Button>
              </TabsContent>
              
              <TabsContent value="manual" className="flex-1 space-y-4 mt-4">
                <div className="space-y-3">
                  <div>
                    <h3 className="font-medium mb-2">Manual File Copy (Best for Large Datasets)</h3>
                    <p className="text-sm text-muted-foreground">
                      For datasets with 1000+ images, manually copying files is 10-100x faster than creating a ZIP archive.
                    </p>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="flex gap-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm font-medium flex-shrink-0">
                        1
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">Export Database Only (JSON)</p>
                        <p className="text-xs text-muted-foreground mt-1">Click "Database Only" in the Export Method tab</p>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm font-medium flex-shrink-0">
                        2
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium mb-2">Copy Image Directories</p>
                        
                        <Collapsible open={linuxExpanded} onOpenChange={setLinuxExpanded}>
                          <CollapsibleTrigger asChild>
                            <Button variant="outline" size="sm" className="mb-2">
                              {linuxExpanded ? (
                                <ChevronDown className="w-4 h-4 mr-1" />
                              ) : (
                                <ChevronRight className="w-4 h-4 mr-1" />
                              )}
                              Linux / Mac Commands
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="space-y-2">
                              <div className="relative border rounded-lg bg-muted overflow-hidden">
                                <div className="flex items-start justify-between p-2 border-b bg-background">
                                  <span className="text-xs text-muted-foreground font-medium">Commands</span>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText("rsync -av /path/to/lai/backend/projects/ /destination/projects/\nrsync -av /path/to/lai/backend/data/ /destination/data/");
                                      setCopiedCommand("linux");
                                      setTimeout(() => setCopiedCommand(null), 2000);
                                    }}
                                    title={copiedCommand === "linux" ? "Copied!" : "Copy commands"}
                                  >
                                    {copiedCommand === "linux" ? (
                                      <>
                                        <Check className="w-3.5 h-3.5 mr-1.5 text-green-600" />
                                        <span className="text-xs text-green-600">Copied</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-3.5 h-3.5 mr-1.5" />
                                        <span className="text-xs">Copy</span>
                                      </>
                                    )}
                                  </Button>
                                </div>
                                <pre className="p-3 text-xs font-mono overflow-x-auto max-h-32 overflow-y-auto">
rsync -av /path/to/lai/backend/projects/ /destination/projects/
rsync -av /path/to/lai/backend/data/ /destination/data/</pre>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                        
                        <Collapsible open={windowsExpanded} onOpenChange={setWindowsExpanded}>
                          <CollapsibleTrigger asChild>
                            <Button variant="outline" size="sm">
                              {windowsExpanded ? (
                                <ChevronDown className="w-4 h-4 mr-1" />
                              ) : (
                                <ChevronRight className="w-4 h-4 mr-1" />
                              )}
                              Windows PowerShell Commands
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="space-y-2 mt-2">
                              <div className="relative border rounded-lg bg-muted overflow-hidden">
                                <div className="flex items-start justify-between p-2 border-b bg-background">
                                  <span className="text-xs text-muted-foreground font-medium">Commands</span>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigator.clipboard.writeText("Copy-Item -Recurse C:\\path\\to\\lai\\backend\\projects\\ C:\\destination\\projects\\\nCopy-Item -Recurse C:\\path\\to\\lai\\backend\\data\\ C:\\destination\\data\\");
                                      setCopiedCommand("windows");
                                      setTimeout(() => setCopiedCommand(null), 2000);
                                    }}
                                    title={copiedCommand === "windows" ? "Copied!" : "Copy commands"}
                                  >
                                    {copiedCommand === "windows" ? (
                                      <>
                                        <Check className="w-3.5 h-3.5 mr-1.5 text-green-600" />
                                        <span className="text-xs text-green-600">Copied</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-3.5 h-3.5 mr-1.5" />
                                        <span className="text-xs">Copy</span>
                                      </>
                                    )}
                                  </Button>
                                </div>
                                <pre className="p-3 text-xs font-mono overflow-x-auto max-h-32 overflow-y-auto">
Copy-Item -Recurse C:\path\to\lai\backend\projects\ C:\destination\projects\
Copy-Item -Recurse C:\path\to\lai\backend\data\ C:\destination\data\</pre>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-sm font-medium flex-shrink-0">
                        3
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">Import on Target System</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Import the JSON file first, then place the copied folders in the backend directory
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Export Progress</span>
                    <span className="text-sm text-muted-foreground">
                      {exportProgress === 100 ? "100%" : `${exportProgress}%`}
                    </span>
                  </div>
                  <Progress value={exportProgress} className="w-full" />
                  <p className="text-xs text-muted-foreground text-center">
                    {exportStage === "files"
                      ? `Adding files${activeExportTask?.task_metadata?.files_total
                          ? ` (${activeExportTask.task_metadata.files_done ?? 0}/${activeExportTask.task_metadata.files_total})`
                          : ""}...`
                      : exportStage || "Export in progress..."}
                  </p>
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelExport}
                      className="w-full"
                    >
                      Cancel Export
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </DialogContent>
      </Dialog>
      )}

      {/* Import Dialog */}
      {showImport && (
        <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className="flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            Import Database
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5" />
              Import Database
            </DialogTitle>
            <DialogDescription>
              Import a previously exported database. This will replace all existing data.
            </DialogDescription>
          </DialogHeader>
          
          <Card className="border-destructive/20 bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">Warning</p>
                  <p className="text-sm text-muted-foreground">
                    This action will completely replace your current database. All existing projects, 
                    datasets, and annotations will be permanently deleted.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Select Import File</label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".json,.zip"
                onChange={handleFileSelect}
                disabled={isImporting}
                className="cursor-pointer"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Supported formats: JSON (database only) or ZIP (complete archive)
              </p>
            </div>
          </div>
          
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowImportDialog(false)}
              disabled={isImporting}
            >
              Cancel
            </Button>
            <Button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isImporting ? "Importing..." : "Choose File & Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      {/* Clear Database Dialog */}
      {showClear && (
        <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogTrigger asChild>
          <Button 
            variant="destructive" 
            size="sm" 
            className="flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Clear Database
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Skull className="w-5 h-5" />
              Clear Database - DANGER ZONE
            </DialogTitle>
            <DialogDescription>
              This will permanently delete ALL data and files. This action cannot be undone!
            </DialogDescription>
          </DialogHeader>
          
          <Card className="border-destructive bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <Skull className="w-5 h-5 text-destructive mt-0.5" />
                <div className="space-y-2">
                  <p className="text-sm font-medium text-destructive">PERMANENT DATA DESTRUCTION</p>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• All projects and datasets will be deleted</li>
                    <li>• All images and annotations will be removed</li>
                    <li>• All physical files will be erased</li>
                    <li>• This action is irreversible</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          {databaseInfo && (
            <Card className="border-orange-200 bg-orange-50">
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-orange-800 mb-2">Data to be destroyed:</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-orange-700">
                  <div>{databaseInfo.database_info.projects} Projects</div>
                  <div>{databaseInfo.database_info.datasets} Datasets</div>
                  <div>{databaseInfo.database_info.images.toLocaleString()} Images</div>
                  <div>{databaseInfo.database_info.annotations.toLocaleString()} Annotations</div>
                </div>
                <div className="mt-2 pt-2 border-t border-orange-200">
                  <div className="text-sm font-medium text-orange-800">
                    Total: {databaseInfo.database_info.total_records.toLocaleString()} records
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block text-destructive">
                Type "DELETE ALL DATA" to confirm:
              </label>
              <Input
                value={clearConfirmText}
                onChange={(e) => setClearConfirmText(e.target.value)}
                placeholder="DELETE ALL DATA"
                disabled={isClearing}
                className="font-mono"
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowClearDialog(false);
                setClearConfirmText("");
              }}
              disabled={isClearing}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleClearDatabase}
              disabled={isClearing || clearConfirmText !== "DELETE ALL DATA"}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isClearing ? (
                <>
                  <Skull className="w-4 h-4 mr-2 animate-pulse" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  DESTROY ALL DATA
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}

      {/* Quick info button */}
      {showInfo && (
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={fetchDatabaseInfo}
          className="flex items-center gap-2"
        >
          <Info className="w-4 h-4" />
          <span className="sr-only">Database Info</span>
        </Button>
      )}
      </div>
    </>
  );
}
