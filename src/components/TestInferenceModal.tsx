import { SharedTestInferenceModal, InferenceResult } from "./SharedTestInferenceModal";
import { postApiFormData } from "@/config/api";

interface TestInferenceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onnxFilePath: string;
  taskId: number;
}

export function TestInferenceModal({
  open,
  onOpenChange,
  onnxFilePath,
  taskId,
}: TestInferenceModalProps) {
  const handleRunInference = async (image: File): Promise<InferenceResult> => {
    const formData = new FormData();
    formData.append('image', image);
    formData.append('onnx_file_path', onnxFilePath);
    formData.append('task_id', taskId.toString());

    const response = await postApiFormData("/export/test-inference", formData);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || 'Inference failed');
    }

    if (data.success) {
      return data.result;
    } else {
      throw new Error(data.error || 'Inference failed');
    }
  };

  return (
    <SharedTestInferenceModal
      open={open}
      onOpenChange={onOpenChange}
      title="Test ONNX Model Inference"
      description="Upload an image to test the exported ONNX model predictions"
      onRunInference={handleRunInference}
    />
  );
}
