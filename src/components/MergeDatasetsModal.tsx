import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Database, 
  Image as ImageIcon, 
  Layers,
  GitMerge,
  Loader2
} from "lucide-react";
import { Dataset } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { getApiBaseUrl } from "@/config/api";

interface MergeDatasetsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  datasets: Dataset[];
  onMergeComplete?: () => void;
}

export function MergeDatasetsModal({
  open,
  onOpenChange,
  projectId,
  datasets,
  onMergeComplete
}: MergeDatasetsModalProps) {
  const [name, setName] = useState("");
  const [selectedDatasets, setSelectedDatasets] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setName("");
      setSelectedDatasets([]);
    }
  }, [open]);

  const handleDatasetToggle = (datasetId: number) => {
    setSelectedDatasets(prev => 
      prev.includes(datasetId)
        ? prev.filter(id => id !== datasetId)
        : [...prev, datasetId]
    );
  };

  const handleSelectAll = () => {
    if (selectedDatasets.length === datasets.length) {
      setSelectedDatasets([]);
    } else {
      setSelectedDatasets(datasets.map(d => d.id));
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({
        title: "Error",
        description: "Merged dataset name is required",
        variant: "destructive",
      });
      return;
    }

    if (selectedDatasets.length < 2) {
      toast({
        title: "Error", 
        description: "Please select at least 2 datasets to merge",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(`${getApiBaseUrl()}/projects/${projectId}/datasets/merge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name.trim(),
          dataset_ids: selectedDatasets
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to merge datasets');
      }

      const result = await response.json();
      
      if (result.success) {
        toast({
          title: "Success",
          description: `Datasets merged into "${name}" successfully. ${result.data?.total_images || 0} images and ${result.data?.total_annotations || 0} annotations copied.`,
        });
        
        // Close modal and refresh data
        onOpenChange(false);
        onMergeComplete?.();
      } else {
        throw new Error(result.error || 'Failed to merge datasets');
      }
    } catch (error) {
      console.error('Error merging datasets:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to merge datasets",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getTotalStats = () => {
    const selected = datasets.filter(d => selectedDatasets.includes(d.id));
    return {
      images: selected.reduce((sum, d) => sum + (d.image_count || 0), 0),
      annotations: selected.reduce((sum, d) => sum + (d.annotation_count || 0), 0)
    };
  };

  const stats = getTotalStats();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5" />
            Merge Datasets
          </DialogTitle>
          <DialogDescription>
            Merge multiple datasets into a single new dataset. Images and annotations will be copied and renamed with the source dataset name as prefix.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Merged Dataset Name */}
          <div>
            <Label htmlFor="merge-name">New Dataset Name *</Label>
            <Input
              id="merge-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter merged dataset name..."
              className="mt-1"
            />
          </div>

          {/* Dataset Selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Select Datasets to Merge ({selectedDatasets.length} selected)</Label>
              <div className="flex items-center gap-4">
                {selectedDatasets.length > 0 && (
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <ImageIcon className="h-3 w-3" />
                      {stats.images} images
                    </div>
                    <div className="flex items-center gap-1">
                      <Layers className="h-3 w-3" />
                      {stats.annotations} annotations
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  {selectedDatasets.length === datasets.length ? "Deselect All" : "Select All"}
                </Button>
              </div>
            </div>

            <ScrollArea className="h-[300px] rounded-md border p-4">
              {datasets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <Database className="h-8 w-8 mb-2" />
                  <p>No datasets available to merge</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {datasets.map((dataset) => (
                    <Card 
                      key={dataset.id}
                      className={`cursor-pointer transition-colors ${
                        selectedDatasets.includes(dataset.id)
                          ? 'border-primary bg-primary/5'
                          : 'hover:border-gray-400'
                      }`}
                      onClick={() => handleDatasetToggle(dataset.id)}
                    >
                      <CardContent className="p-3">
                        <div className="flex items-start gap-3">
                          <Checkbox 
                            checked={selectedDatasets.includes(dataset.id)}
                            onChange={() => handleDatasetToggle(dataset.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Database className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                              <h4 className="font-medium truncate">{dataset.name}</h4>
                            </div>
                            <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground">
                              <div className="flex items-center gap-1">
                                <ImageIcon className="h-3 w-3" />
                                {dataset.image_count || 0} images
                              </div>
                              <div className="flex items-center gap-1">
                                <Layers className="h-3 w-3" />
                                {dataset.annotation_count || 0} annotations
                              </div>
                            </div>
                            {dataset.description && (
                              <p className="text-xs text-muted-foreground mt-1 truncate">
                                {dataset.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Info about renaming */}
          {selectedDatasets.length >= 2 && (
            <div className="bg-muted/50 rounded-md p-3 text-sm">
              <p className="font-medium mb-1">How merging works:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>Images will be copied with format: <code className="bg-muted px-1 rounded">datasetName_originalFileName</code></li>
                <li>All annotations will be updated to reference the renamed images</li>
                <li>Original datasets will remain unchanged</li>
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit}
            disabled={isLoading || selectedDatasets.length < 2 || !name.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="mr-2 h-4 w-4" />
                Merge {selectedDatasets.length} Datasets
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
