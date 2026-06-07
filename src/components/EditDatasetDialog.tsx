import { useState } from "react";
import { Dataset, DatasetFormValues } from "@/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DatasetForm } from "@/components/DatasetForm";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/hooks/use-toast";

interface EditDatasetDialogProps {
  dataset: Dataset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDatasetUpdated?: (dataset: Dataset) => void;
}

export function EditDatasetDialog({ dataset, open, onOpenChange, onDatasetUpdated }: EditDatasetDialogProps) {
  const [loading, setLoading] = useState(false);
  const { api, isConfigured } = useApi();
  const { toast } = useToast();

  const handleSubmit = async (data: DatasetFormValues, logoFile?: File) => {
    if (!api || !isConfigured) {
      toast({
        title: "Error",
        description: "API client is not configured",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      const formData = new FormData();
      formData.append('name', data.name.trim());
      formData.append('description', data.description?.trim() || "");
      formData.append('tags', JSON.stringify(data.tags || []));

      if (logoFile) {
        formData.append('logo', logoFile);
      }

      const response = await api.updateDataset(dataset.id, formData);

      if (!response.success) {
        throw new Error(response.error || "Failed to update dataset");
      }

      toast({
        title: "Success",
        description: "Dataset updated successfully",
      });

      if (onDatasetUpdated) {
        onDatasetUpdated(response.data);
      }
      
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to update dataset",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Dataset</DialogTitle>
        </DialogHeader>
        <DatasetForm
          initialData={dataset}
          onSubmit={handleSubmit}
          loading={loading}
          mode="edit"
        />
      </DialogContent>
    </Dialog>
  );
}