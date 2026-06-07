import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SharedTestInferenceModal, InferenceResult } from "./SharedTestInferenceModal";
import { buildApiUrl, postApiFormData } from "@/config/api";

interface TestTrainingInferenceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
  taskName: string;
  availableCheckpoints?: string[];
}

export function TestTrainingInferenceModal({
  open,
  onOpenChange,
  taskId,
  taskName,
  availableCheckpoints: initialCheckpoints = ['best', 'last'],
}: TestTrainingInferenceModalProps) {
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>('best');
  const [availableCheckpoints, setAvailableCheckpoints] = useState<string[]>(initialCheckpoints);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);

  // Fetch available checkpoints when modal opens
  useEffect(() => {
    if (open && taskId) {
      fetchCheckpoints();
    }
  }, [open, taskId]);

  const fetchCheckpoints = async () => {
    setLoadingCheckpoints(true);
    try {
      const response = await fetch(buildApiUrl(`/training/${taskId}/checkpoints`), {
        mode: "cors",
        credentials: "omit",
        cache: "no-cache",
      });
      if (response.ok) {
        const data = await response.json();
        if (data.checkpoints && Array.isArray(data.checkpoints)) {
          // Checkpoints can be array of strings or array of objects with 'name' property
          const checkpointNames = data.checkpoints.map((c: any) => 
            typeof c === 'string' ? c : c.name
          );
          setAvailableCheckpoints(checkpointNames);
          // Set default to 'best' if available, otherwise first checkpoint
          if (checkpointNames.includes('best')) {
            setSelectedCheckpoint('best');
          } else if (checkpointNames.length > 0) {
            setSelectedCheckpoint(checkpointNames[0]);
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch checkpoints:', error);
    } finally {
      setLoadingCheckpoints(false);
    }
  };

  const handleRunInference = async (image: File): Promise<InferenceResult> => {
    const formData = new FormData();
    formData.append('image', image);

    const response = await postApiFormData(
      `/training/${taskId}/test-inference`,
      formData,
      { checkpoint: selectedCheckpoint },
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || 'Inference failed');
    }

    if (data.success) {
      // Ultralytics/celery wraps payload in result; legacy MMYOLO used top-level predictions.
      if (data.result) {
        return data.result;
      }
      return {
        predictions: data.predictions ?? [],
        image_url: data.image_url,
      };
    }
    throw new Error(data.error || 'Inference failed');
  };

  const checkpointSelector = (
    <div className="space-y-2">
      <Label htmlFor="checkpoint-select">Checkpoint</Label>
      <Select
        value={selectedCheckpoint}
        onValueChange={setSelectedCheckpoint}
        disabled={loadingCheckpoints}
      >
        <SelectTrigger id="checkpoint-select">
          <SelectValue placeholder="Select checkpoint" />
        </SelectTrigger>
        <SelectContent>
          {availableCheckpoints.map((checkpoint) => (
            <SelectItem key={checkpoint} value={checkpoint}>
              {checkpoint}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <SharedTestInferenceModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Test Model Inference - ${taskName}`}
      description="Upload an image to test the trained model predictions"
      onRunInference={handleRunInference}
      additionalControls={checkpointSelector}
    />
  );
}
