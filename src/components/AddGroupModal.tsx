import { useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { FolderPlus, Image as ImageIcon, Layers } from "lucide-react";
import { Dataset, DatasetGroup } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { getApiBaseUrl } from "@/config/api";
import { DatasetTransferList } from "./DatasetTransferList";

interface AddGroupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  datasets: Dataset[];
  datasetGroups?: DatasetGroup[];
  onGroupCreated?: () => void;
}

export function AddGroupModal({
  open,
  onOpenChange,
  projectId,
  datasets,
  datasetGroups = [],
  onGroupCreated,
}: AddGroupModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [selectedDatasets, setSelectedDatasets] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const allDatasets = useMemo(() => {
    const map = new Map<number, Dataset>();
    datasets.forEach(d => map.set(d.id, d));
    datasetGroups.forEach(g => (g.datasets || []).forEach(d => { if (!map.has(d.id)) map.set(d.id, d); }));
    return Array.from(map.values());
  }, [datasets, datasetGroups]);

  const stats = useMemo(() => {
    const sel = allDatasets.filter(d => selectedDatasets.includes(d.id));
    return {
      images: sel.reduce((s, d) => s + (d.image_count || 0), 0),
      annotations: sel.reduce((s, d) => s + (d.annotation_count || 0), 0),
    };
  }, [allDatasets, selectedDatasets]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({ title: "Error", description: "Group name is required", variant: "destructive" });
      return;
    }
    if (selectedDatasets.length === 0) {
      toast({ title: "Error", description: "Please select at least one dataset", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("description", description);
      formData.append("url", url);
      formData.append("dataset_ids", selectedDatasets.join(","));

      const response = await fetch(`${getApiBaseUrl()}/projects/${projectId}/dataset-groups/`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to create group");
      }

      const result = await response.json();
      if (result.success) {
        toast({ title: "Success", description: `Group "${name}" created successfully` });
        setName("");
        setDescription("");
        setUrl("");
        setSelectedDatasets([]);
        onOpenChange(false);
        onGroupCreated?.();
      } else {
        throw new Error(result.error || "Failed to create group");
      }
    } catch (error) {
      console.error("Error creating group:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create group",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="h-5 w-5" />
            Create Dataset Group
          </DialogTitle>
          <DialogDescription>
            Group related datasets together. Datasets already in another group can still be added.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-1">
              <Label htmlFor="group-name">Group Name *</Label>
              <Input
                id="group-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Urban scenes"
                className="mt-1"
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="group-description">Description</Label>
              <Input
                id="group-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Short description (optional)"
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Datasets ({selectedDatasets.length} selected)</Label>
              {selectedDatasets.length > 0 && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><ImageIcon className="h-3 w-3" />{stats.images} images</span>
                  <span className="flex items-center gap-1"><Layers className="h-3 w-3" />{stats.annotations} annotations</span>
                </div>
              )}
            </div>
            <DatasetTransferList
              allDatasets={allDatasets}
              datasetGroups={datasetGroups}
              selected={selectedDatasets}
              onChange={setSelectedDatasets}
            />
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !name.trim() || selectedDatasets.length === 0}
          >
            {isLoading ? "Creating..." : "Create Group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
