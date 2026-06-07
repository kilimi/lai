import { Navbar } from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { 
  ArrowLeft, 
  AlertTriangle, 
  Database, 
  Download, 
  Upload, 
  Trash2, 
  Settings as SettingsIcon, 
  CheckCircle2, 
  XCircle,
  Server,
  RefreshCw,
  HardDrive,
  Shield,
  Zap,
  ExternalLink,
  Save,
  Clock,
  FolderOpen,
  Play,
  Info,
  Copy,
  Check
} from "lucide-react";
import { Link } from "react-router-dom";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { API_CONFIG } from "@/config/api";
import { useToast } from "@/components/ui/use-toast";
import { ApiClient } from "@/utils/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Dataset } from "@/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { DatabaseManager } from "@/components/DatabaseManager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

export const ApiSettings = () => {
  const { toast } = useToast();
  const [apiUrl, setApiUrl] = useState(API_CONFIG.baseUrl);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isLoadingDatasets, setIsLoadingDatasets] = useState(false);
  const [showDatasetsDialog, setShowDatasetsDialog] = useState(false);
  
  // Backup settings state
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupPath, setBackupPath] = useState("");
  const [backupPathEnv, setBackupPathEnv] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [frequencyHours, setFrequencyHours] = useState(24);
  const [retentionDays, setRetentionDays] = useState(30);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [nextBackupAt, setNextBackupAt] = useState<string | null>(null);
  const [isLoadingBackupSettings, setIsLoadingBackupSettings] = useState(false);
  const [isSavingBackupSettings, setIsSavingBackupSettings] = useState(false);
  const [isRunningBackup, setIsRunningBackup] = useState(false);
  const [backups, setBackups] = useState<any[]>([]);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      const apiClient = new ApiClient({ baseUrl: API_CONFIG.baseUrl });
      const result = await apiClient.testConnection();
      
      if (result.success) {
        setIsConnected(true);
        setTestResult("Backend server is running and accessible.");
      } else {
        setIsConnected(false);
        setTestResult(`${result.error}`);
      }
    } catch (error) {
      setIsConnected(false);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTestResult(`${errorMessage}`);
    }
  };

  const handleTestConnection = async () => {
    setIsLoading(true);
    try {
      const apiClient = new ApiClient({ baseUrl: apiUrl });
      const result = await apiClient.testConnection();
      
      if (result.success) {
        setIsConnected(true);
        setTestResult("Backend server is running and accessible.");
        toast({
          title: "Connection successful",
          description: "Your backend connection is working correctly",
        });
      } else {
        setIsConnected(false);
        setTestResult(`${result.error}`);
        toast({
          title: "Connection failed",
          description: result.error || "Could not connect to the API",
          variant: "destructive",
        });
      }
    } catch (error) {
      setIsConnected(false);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTestResult(`${errorMessage}`);
      toast({
        title: "Connection error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isConnected) {
      loadDatasets();
      loadBackupSettings();
      loadBackups();
    }
  }, [isConnected]);
  
  const loadBackupSettings = async () => {
    setIsLoadingBackupSettings(true);
    try {
      const apiClient = new ApiClient({ ...API_CONFIG, baseUrl: apiUrl });
      const response = await apiClient.request<any>('/backup/settings', {
        method: 'GET',
      });
      
      if (response.success && response.data) {
        setBackupEnabled(response.data.enabled || false);
        setBackupPath(response.data.backup_path || "");
        setBackupPathEnv(response.data.backup_path_env || null);
        setFrequencyHours(response.data.frequency_hours || 24);
        setRetentionDays(response.data.retention_days || 30);
        setLastBackupAt(response.data.last_backup_at || null);
        setNextBackupAt(response.data.next_backup_at || null);
      }
    } catch (error) {
      console.error('Failed to load backup settings:', error);
    } finally {
      setIsLoadingBackupSettings(false);
    }
  };
  
  const loadBackups = async () => {
    try {
      const apiClient = new ApiClient({ ...API_CONFIG, baseUrl: apiUrl });
      const response = await apiClient.request<any>('/backup/list', {
        method: 'GET',
      });
      
      if (response.success && response.data) {
        setBackups(response.data.backups || []);
      }
    } catch (error) {
      console.error('Failed to load backups:', error);
    }
  };
  
  const saveBackupSettings = async () => {
    setIsSavingBackupSettings(true);
    try {
      const apiClient = new ApiClient({ ...API_CONFIG, baseUrl: apiUrl });
      const response = await apiClient.request<any>('/backup/settings', {
        method: 'POST',
        body: JSON.stringify({
          enabled: backupEnabled,
          backup_path: backupPath,
          frequency_hours: frequencyHours,
          retention_days: retentionDays,
        }),
      });
      
      if (response.success) {
        toast({
          title: "Settings saved",
          description: "Backup settings have been updated successfully.",
        });
        await loadBackupSettings();
      } else {
        throw new Error(response.error || "Failed to save settings");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save backup settings",
        variant: "destructive",
      });
    } finally {
      setIsSavingBackupSettings(false);
    }
  };
  
  const runBackup = async () => {
    setIsRunningBackup(true);
    try {
      const apiClient = new ApiClient({ ...API_CONFIG, baseUrl: apiUrl });
      const response = await apiClient.request<any>('/backup/run', {
        method: 'POST',
      });
      
      if (response.success) {
        toast({
          title: "Backup started",
          description: "Backup is running in the background. Check the backup list for status.",
        });
        // Refresh backups after a delay
        setTimeout(() => {
          loadBackups();
          loadBackupSettings();
        }, 2000);
      } else {
        throw new Error(response.error || "Failed to start backup");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to start backup",
        variant: "destructive",
      });
    } finally {
      setIsRunningBackup(false);
    }
  };

  const loadDatasets = async () => {
    setIsLoadingDatasets(true);
    try {
      const apiClient = new ApiClient({ ...API_CONFIG, baseUrl: apiUrl });
      const response = await apiClient.getDatasets();
      
      if (response.success) {
        setDatasets(response.data || []);
      } else {
        console.error('Failed to load datasets:', response.error);
        setDatasets([]);
      }
    } catch (error) {
      console.error('Failed to load datasets:', error);
      setDatasets([]);
    } finally {
      setIsLoadingDatasets(false);
    }
  };

  const handleGetAllDatasets = async () => {
    await loadDatasets();
    setShowDatasetsDialog(true);
  };

  const saveSettings = () => {
    localStorage.setItem("apiBaseUrl", apiUrl);
    
    toast({
      title: "Settings saved",
      description: "API URL has been updated. Reloading app to apply changes.",
    });
    
    setTimeout(() => {
      window.location.href = "/";
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      <Navbar />
      
      <main className="container max-w-6xl pt-24 pb-16 px-4 md:px-6 animate-fade-in">
        {/* Header */}
        <div className="mb-10">
          <Button variant="ghost" asChild className="mb-6 -ml-2 text-muted-foreground hover:text-foreground transition-colors">
              <Link to="/" className="flex items-center gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
          </Button>
          
          <div className="flex items-start gap-4">
            <div className="p-4 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 shadow-lg shadow-primary/5">
              <SettingsIcon className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">
                Settings
              </h1>
              <p className="text-muted-foreground mt-2 text-lg">
                Configure your backend connection and manage your data
              </p>
            </div>
          </div>
        </div>

        {/* Connection Status Banner */}
        {isConnected !== null && (
          <div className={`mb-8 p-4 rounded-xl border-2 flex items-center gap-4 transition-all ${
            isConnected 
              ? "bg-emerald-500/5 border-emerald-500/20" 
              : "bg-red-500/5 border-red-500/20"
          }`}>
            <div className={`p-3 rounded-xl ${
              isConnected 
                ? "bg-emerald-500/10" 
                : "bg-red-500/10"
            }`}>
              {isConnected ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              ) : (
                <XCircle className="h-6 w-6 text-red-500" />
              )}
            </div>
            <div className="flex-1">
              <p className={`font-semibold ${isConnected ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                {isConnected ? "Connected to Backend" : "Not Connected"}
              </p>
              <p className="text-sm text-muted-foreground">
                {testResult}
              </p>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleTestConnection}
              disabled={isLoading}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              {isLoading ? "Testing..." : "Refresh"}
            </Button>
          </div>
        )}

        <Tabs defaultValue="connection" className="space-y-8">
          <TabsList className="grid w-full grid-cols-3 h-14 p-1.5 bg-muted/50 rounded-xl">
            <TabsTrigger value="connection" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm h-10">
              <Server className="h-4 w-4" />
              <span className="hidden sm:inline">Connection</span>
            </TabsTrigger>
            <TabsTrigger value="data" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm h-10">
              <HardDrive className="h-4 w-4" />
              <span className="hidden sm:inline">Data Management</span>
            </TabsTrigger>
            <TabsTrigger value="advanced" className="flex items-center gap-2 rounded-lg data-[state=active]:bg-background data-[state=active]:shadow-sm h-10">
              <Shield className="h-4 w-4" />
              <span className="hidden sm:inline">Advanced</span>
            </TabsTrigger>
          </TabsList>

          {/* Connection Tab */}
          <TabsContent value="connection" className="space-y-6">
            <Card className="border-2 shadow-lg overflow-hidden">
              <CardHeader className="bg-gradient-to-r from-muted/50 to-transparent border-b">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-primary/10">
                    <Database className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">Backend API</CardTitle>
                    <CardDescription className="text-base">
                      Configure your FastAPI backend server connection
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="space-y-3">
                  <Label htmlFor="api-url" className="text-sm font-medium flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    Backend URL
                  </Label>
                  <div className="flex gap-3">
                    <Input 
                      id="api-url"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="http://localhost:9999"
                      className="font-mono text-sm h-12 bg-muted/30 border-2 focus:border-primary/50"
                    />
                    <Button 
                      onClick={handleTestConnection}
                      disabled={isLoading}
                      variant="secondary"
                      className="h-12 px-6 font-medium"
                    >
                      {isLoading ? (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                          Testing...
                        </>
                      ) : "Test Connection"}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Leave empty or use the same host as this page (Docker/Vite proxy).
                    Do not use <code className="text-xs">localhost:9999</code> when opening the app by LAN IP.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                  <div className="p-4 rounded-xl border-2 bg-muted/20 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3 mb-2">
                      <Database className="h-5 w-5 text-primary" />
                      <span className="font-medium">Datasets</span>
                    </div>
                    <p className="text-2xl font-bold text-primary">{datasets.length}</p>
                    <p className="text-sm text-muted-foreground">Available in database</p>
                  </div>
                  <div className="p-4 rounded-xl border-2 bg-muted/20 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3 mb-2">
                      <Server className="h-5 w-5 text-primary" />
                      <span className="font-medium">Status</span>
                    </div>
                    <p className={`text-2xl font-bold ${isConnected ? 'text-emerald-500' : 'text-red-500'}`}>
                      {isConnected ? 'Online' : 'Offline'}
                    </p>
                    <p className="text-sm text-muted-foreground">Backend server status</p>
                  </div>
                </div>

                <div className="flex justify-between items-center pt-4 border-t">
                  <Button 
                    variant="outline"
                    onClick={handleGetAllDatasets}
                    disabled={isLoadingDatasets || !isConnected}
                    className="flex items-center gap-2"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {isLoadingDatasets ? "Loading..." : "View All Datasets"}
                  </Button>
                  <Button 
                    onClick={saveSettings}
                    disabled={isLoading}
                    className="px-8"
                  >
                    Save Changes
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Data Management Tab */}
          <TabsContent value="data" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Export Card */}
              <Card className="border-2 shadow-lg overflow-hidden group hover:border-primary/30 transition-colors">
                <CardHeader className="bg-gradient-to-r from-blue-500/5 to-transparent border-b">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-blue-500/10 group-hover:bg-blue-500/20 transition-colors">
                      <Download className="h-5 w-5 text-blue-500" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Export Data</CardTitle>
                      <CardDescription>
                        Download a backup of all your data
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  <p className="text-sm text-muted-foreground mb-6">
                    Create a complete backup of your projects, datasets, annotations, and images. 
                    The backup file can be used to restore your data later.
                  </p>
                  <DatabaseManager showImport={false} showClear={false} showInfo={false} />
                </CardContent>
              </Card>

              {/* Import Card */}
              <Card className="border-2 shadow-lg overflow-hidden group hover:border-primary/30 transition-colors">
                <CardHeader className="bg-gradient-to-r from-violet-500/5 to-transparent border-b">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-violet-500/10 group-hover:bg-violet-500/20 transition-colors">
                      <Upload className="h-5 w-5 text-violet-500" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Import Data</CardTitle>
                      <CardDescription>
                        Restore from a previous backup
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  <p className="text-sm text-muted-foreground mb-6">
                    Restore your projects and datasets from a backup file. 
                    This will merge the imported data with your existing data.
                  </p>
                  <DatabaseManager showExport={false} showClear={false} showInfo={false} />
                </CardContent>
              </Card>
            </div>

            {/* Stats Summary */}
            <Card className="border-2">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-muted">
                      <Database className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">Database Summary</p>
                      <p className="text-sm text-muted-foreground">
                        {datasets.length} datasets with {datasets.reduce((sum, d) => sum + d.image_count, 0)} total images
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-sm px-4 py-1">
                    {isConnected ? 'Synced' : 'Offline'}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Automatic Backup Settings */}
            <Card className="border-2 shadow-lg overflow-hidden">
              <CardHeader className="bg-gradient-to-r from-emerald-500/5 to-transparent border-b">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-emerald-500/10">
                    <HardDrive className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">Automatic Backup</CardTitle>
                    <CardDescription className="text-base">
                      Configure automatic incremental backups (ZFS-like snapshots)
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                {/* Enable/Disable Backup */}
                <div className="flex items-center justify-between p-4 rounded-xl border-2 bg-muted/20">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Zap className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <Label htmlFor="backup-enabled" className="text-base font-medium cursor-pointer">
                        Enable Automatic Backups
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically backup database and files at configured intervals
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="backup-enabled"
                    checked={backupEnabled}
                    onCheckedChange={setBackupEnabled}
                    disabled={isLoadingBackupSettings}
                  />
                </div>

                {backupEnabled && (
                  <>
                    <Separator />
                    
                    {/* Backup Path Configuration */}
                    <div className="space-y-4">
                      {/* Current BACKUP_PATH Environment Variable */}
                      {backupPathEnv && (
                        <div className="p-4 rounded-xl border-2 bg-emerald-500/5 border-emerald-500/20">
                          <div className="flex items-start gap-3">
                            <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5 flex-shrink-0" />
                            <div className="flex-1">
                              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400 mb-1">
                                Custom Backup Path Configured
                              </p>
                              <p className="text-sm text-muted-foreground mb-2">
                                Backups will be stored in:
                              </p>
                              <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                                <code className="text-xs font-mono flex-1 break-all">{backupPathEnv}</code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    navigator.clipboard.writeText(backupPathEnv);
                                    setCopiedText(backupPathEnv);
                                    setTimeout(() => setCopiedText(null), 2000);
                                    toast({
                                      title: "Copied!",
                                      description: "Path copied to clipboard",
                                    });
                                  }}
                                  className="h-7 w-7 p-0 flex-shrink-0"
                                >
                                  {copiedText === backupPathEnv ? (
                                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Subdirectory Path */}
                      <div className="space-y-3">
                        <Label htmlFor="backup-path" className="text-sm font-medium flex items-center gap-2">
                          <FolderOpen className="h-4 w-4 text-primary" />
                          Subdirectory (Optional)
                        </Label>
                        <Input
                          id="backup-path"
                          value={backupPath}
                          onChange={(e) => setBackupPath(e.target.value)}
                          placeholder="daily or 2024/january"
                          className="font-mono text-sm h-12 bg-muted/30 border-2 focus:border-primary/50"
                          disabled={isLoadingBackupSettings}
                        />
                        <p className="text-sm text-muted-foreground">
                          Enter a subdirectory name (or leave empty for root). This creates a folder inside your backup directory.
                          <br />
                          <strong>Examples:</strong>
                          <br />• Leave empty → Root of backup directory
                          <br />• "daily" → <code className="text-xs bg-muted px-1 py-0.5 rounded">{backupPathEnv || './backups'}/daily/</code>
                          <br />• "2024/january" → <code className="text-xs bg-muted px-1 py-0.5 rounded">{backupPathEnv || './backups'}/2024/january/</code>
                        </p>
                      </div>

                      {/* Custom Path Setup Instructions */}
                      {!backupPathEnv && (
                        <div className="p-4 rounded-xl border-2 bg-blue-500/5 border-blue-500/20">
                          <div className="flex items-start gap-3">
                            <Info className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                            <div className="flex-1 space-y-3">
                              <div>
                                <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-1">
                                  Want to store backups outside the project folder?
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Set the <code className="text-xs bg-muted px-1 py-0.5 rounded">BACKUP_PATH</code> environment variable before starting Docker.
                                </p>
                              </div>
                              
                              <div className="space-y-2">
                                <div>
                                  <p className="text-xs font-medium text-muted-foreground mb-1">Step 1: Set the environment variable</p>
                                  <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                                    <code className="text-xs font-mono flex-1 break-all">export BACKUP_PATH=/path/to/your/backups</code>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        const cmd = 'export BACKUP_PATH=/path/to/your/backups';
                                        navigator.clipboard.writeText(cmd);
                                        setCopiedText(cmd);
                                        setTimeout(() => setCopiedText(null), 2000);
                                        toast({
                                          title: "Copied!",
                                          description: "Command copied to clipboard",
                                        });
                                      }}
                                      className="h-7 w-7 p-0 flex-shrink-0"
                                    >
                                      {copiedText === 'export BACKUP_PATH=/path/to/your/backups' ? (
                                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                                      ) : (
                                        <Copy className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  </div>
                                </div>
                                
                                <div>
                                  <p className="text-xs font-medium text-muted-foreground mb-1">Step 2: Restart Docker containers</p>
                                  <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
                                    <code className="text-xs font-mono flex-1 break-all">cd backend && docker compose down && docker compose up -d</code>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        const cmd = 'cd backend && docker compose down && docker compose up -d';
                                        navigator.clipboard.writeText(cmd);
                                        setCopiedText(cmd);
                                        setTimeout(() => setCopiedText(null), 2000);
                                        toast({
                                          title: "Copied!",
                                          description: "Command copied to clipboard",
                                        });
                                      }}
                                      className="h-7 w-7 p-0 flex-shrink-0"
                                    >
                                      {copiedText === 'cd backend && docker compose down && docker compose up -d' ? (
                                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                                      ) : (
                                        <Copy className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  </div>
                                </div>

                                <div className="pt-2 border-t">
                                  <p className="text-xs font-medium text-muted-foreground mb-1">Example locations:</p>
                                  <ul className="text-xs text-muted-foreground space-y-1 ml-4 list-disc">
                                    <li><code className="bg-muted px-1 py-0.5 rounded">/home/user/backups</code></li>
                                    <li><code className="bg-muted px-1 py-0.5 rounded">/mnt/external-drive/backups</code></li>
                                    <li><code className="bg-muted px-1 py-0.5 rounded">/var/backups/lai</code></li>
                                  </ul>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Frequency */}
                    <div className="space-y-3">
                      <Label htmlFor="frequency-hours" className="text-sm font-medium flex items-center gap-2">
                        <Clock className="h-4 w-4 text-primary" />
                        Backup Frequency (hours)
                      </Label>
                      <Input
                        id="frequency-hours"
                        type="number"
                        min="1"
                        max="168"
                        value={frequencyHours}
                        onChange={(e) => setFrequencyHours(parseInt(e.target.value) || 24)}
                        className="h-12 bg-muted/30 border-2 focus:border-primary/50"
                        disabled={isLoadingBackupSettings}
                      />
                      <p className="text-sm text-muted-foreground">
                        How often to create a new backup (1-168 hours, e.g., 24 = daily)
                      </p>
                    </div>

                    {/* Retention */}
                    <div className="space-y-3">
                      <Label htmlFor="retention-days" className="text-sm font-medium flex items-center gap-2">
                        <Database className="h-4 w-4 text-primary" />
                        Retention Period (days)
                      </Label>
                      <Input
                        id="retention-days"
                        type="number"
                        min="1"
                        value={retentionDays}
                        onChange={(e) => setRetentionDays(parseInt(e.target.value) || 30)}
                        className="h-12 bg-muted/30 border-2 focus:border-primary/50"
                        disabled={isLoadingBackupSettings}
                      />
                      <p className="text-sm text-muted-foreground">
                        How many days to keep backups before automatic deletion
                      </p>
                    </div>

                    {/* Backup Status */}
                    {(lastBackupAt || nextBackupAt) && (
                      <div className="p-4 rounded-xl border-2 bg-muted/20 space-y-2">
                        <p className="text-sm font-medium">Backup Status</p>
                        {lastBackupAt && (
                          <p className="text-sm text-muted-foreground">
                            Last backup: {new Date(lastBackupAt).toLocaleString()}
                          </p>
                        )}
                        {nextBackupAt && (
                          <p className="text-sm text-muted-foreground">
                            Next backup: {new Date(nextBackupAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                    )}

                    <Separator />

                    {/* Actions */}
                    <div className="flex gap-3">
                      <Button
                        onClick={saveBackupSettings}
                        disabled={isSavingBackupSettings || isLoadingBackupSettings || !backupPath}
                        className="flex-1"
                      >
                        <Save className="h-4 w-4 mr-2" />
                        {isSavingBackupSettings ? "Saving..." : "Save Settings"}
                      </Button>
                      <Button
                        onClick={runBackup}
                        disabled={isRunningBackup || !backupEnabled || !backupPath}
                        variant="outline"
                        className="flex-1"
                      >
                        <Play className="h-4 w-4 mr-2" />
                        {isRunningBackup ? "Running..." : "Run Backup Now"}
                      </Button>
                    </div>
                  </>
                )}

                {/* Backup List */}
                {backups.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-3">
                      <Label className="text-sm font-medium">Recent Backups</Label>
                      <ScrollArea className="h-48 rounded-lg border p-4">
                        <div className="space-y-2">
                          {backups.slice(0, 10).map((backup: any, idx: number) => (
                            <div key={idx} className="flex items-start justify-between p-3 rounded-lg border bg-muted/20 gap-3">
                              <div className="flex-1">
                                <p className="text-sm font-medium">
                                  {backup.backup_name || backup.backup_path?.split('/').pop()}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {backup.created_at && new Date(backup.created_at).toLocaleString()}
                                  {backup.actual_size_bytes && ` • ${(backup.actual_size_bytes / 1024 / 1024).toFixed(2)} MB`}
                                </p>
                                <div className="flex items-center gap-3 mt-2 text-xs">
                                  <span className={`flex items-center gap-1 ${backup.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                                    {backup.status === 'completed' ? (
                                      <CheckCircle2 className="h-3 w-3" />
                                    ) : (
                                      <XCircle className="h-3 w-3" />
                                    )}
                                    {backup.status || 'unknown'}
                                  </span>
                                  {backup.backup_metadata && (
                                    <>
                                      {backup.backup_metadata.files_backed_up !== false && (
                                        <span className="text-muted-foreground">Files ✓</span>
                                      )}
                                      {backup.backup_metadata.database_backed_up !== false && (
                                        <span className="text-muted-foreground">Database ✓</span>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                              <Badge variant={backup.status === 'completed' ? 'default' : 'secondary'}>
                                {backup.status || 'unknown'}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Advanced Tab */}
          <TabsContent value="advanced" className="space-y-6">
            <Card className="border-2 border-red-500/20 shadow-lg overflow-hidden">
              <CardHeader className="bg-gradient-to-r from-red-500/5 to-transparent border-b border-red-500/20">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-red-500/10">
                    <AlertTriangle className="h-5 w-5 text-red-500" />
                  </div>
                  <div>
                    <CardTitle className="text-lg text-red-600 dark:text-red-400">Danger Zone</CardTitle>
                    <CardDescription className="text-red-600/70 dark:text-red-400/70">
                      These actions are irreversible. Proceed with extreme caution.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="p-5 rounded-xl border-2 border-red-500/20 bg-red-500/5">
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-xl bg-red-500/10">
                      <Trash2 className="h-5 w-5 text-red-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-red-600 dark:text-red-400 mb-1">
                        Clear All Data
                      </h3>
                      <p className="text-sm text-red-600/80 dark:text-red-400/80 mb-4">
                        Permanently delete all projects, datasets, annotations, and uploaded files. 
                        This action cannot be undone and all data will be lost forever.
                      </p>
                      <DatabaseManager showExport={false} showImport={false} showClear={true} showInfo={false} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Info Card */}
            <Card className="border-2">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="p-3 rounded-xl bg-muted">
                    <Shield className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Data Security</h3>
                    <p className="text-sm text-muted-foreground">
                      All your data is stored locally on your backend server. No data is sent to external services. 
                      We recommend creating regular backups using the Export feature to prevent data loss.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Datasets Dialog */}
      <Dialog open={showDatasetsDialog} onOpenChange={setShowDatasetsDialog}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              All Datasets
            </DialogTitle>
            <DialogDescription>
              {datasets.length} datasets found in the database
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 mt-4">
            <div className="space-y-3 pr-4">
              {datasets.map((dataset) => (
                <div key={dataset.id} className="p-4 rounded-xl border-2 bg-card hover:border-primary/30 transition-colors">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h3 className="font-semibold text-base">{dataset.name}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">{dataset.description}</p>
                    </div>
                    <Badge variant="secondary">{dataset.image_count} images</Badge>
                  </div>
                  <div className="flex gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Database className="h-3.5 w-3.5" />
                      {dataset.annotation_count} annotations
                    </span>
                    <span>Created {new Date(dataset.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
              {datasets.length === 0 && (
                <div className="text-center py-12">
                  <Database className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                  <p className="text-muted-foreground">No datasets found</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
};
