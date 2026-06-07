import { useEffect, useMemo, useState } from "react";
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
import { Edit, Image as ImageIcon, Layers } from "lucide-react";
import { Dataset, DatasetGroup } from "@/types";
import { useToast } from "@/hooks/use-toast";
import { getApiBaseUrl } from "@/config/api";
import { DatasetTransferList } from "./DatasetTransferList";

interface EditGroupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: DatasetGroup | null;
  availableDatasets: Dataset[];
  datasetGroups?: DatasetGroup[];
  onGroupUpdated?: () => void;
}

export function EditGroupModal({
  open,
  onOpenChange,
  group,
  availableDatasets,
  datasetGroups = [],
  onGroupUpdated,
}: EditGroupModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [selectedDatasets, setSelectedDatasets] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (group) {
      setName(group.name);
      setDescription(group.description || "");
      setUrl(group.url || "");
      setSelectedDatasets(group.dataset_ids || []);
    }
  }, [group]);

  const allDatasets = useMemo(() => {
    const map = new Map<number, Dataset>();
    availableDatasets.forEach(d => map.set(d.id, d));
    datasetGroups.forEach(g => (g.datasets || []).forEach(d => { if (!map.has(d.id)) map.set(d.id, d); }));
    return Array.from(map.values());
  }, [availableDatasets, datasetGroups]);

  const stats = useMemo(() => {
    const sel = allDatasets.filter(d => selectedDatasets.includes(d.id));
    return {
      images: sel.reduce((s, d) => s + (d.image_count || 0), 0),
      annotations: sel.reduce((s, d) => s + (d.annotation_count || 0), 0),
    };
  }, [allDatasets, selectedDatasets]);

  const handleSubmit = async () => {
    if (!group) return;
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

      const response = await fetch(`${getApiBaseUrl()}/dataset-groups/${group.id}`, {
        method: "PUT",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || "Failed to update group");
      }

      const result = await response.json();
      if (result.success) {
        toast({ title: "Success", description: `Group "${name}" updated successfully` });
        onOpenChange(false);
        onGroupUpdated?.();
      } else {
        throw new Error(result.error || "Failed to update group");
      }
    } catch (error) {
      console.error("Error updating group:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update group",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (!group) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit className="h-5 w-5" />
            Edit Dataset Group
          </DialogTitle>
          <DialogDescription>
            Modify the group details and dataset selection.
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
              currentGroupId={group.id}
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
            {isLoading ? "Updating..." : "Update Group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
