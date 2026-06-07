import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { UploadCard } from "@/components/UploadCard";

interface AnnotationsUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilesSelected: (files: File[], type?: string, processMode?: 'immediate' | 'background') => void;
}

export function AnnotationsUploadDialog({
  open,
  onOpenChange,
  onFilesSelected,
}: AnnotationsUploadDialogProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  useEffect(() => {
    if (!open) {
      setSelectedFiles([]);
    }
  }, [open]);

  // Auto-upload when files are selected
  useEffect(() => {
    if (selectedFiles.length > 0) {
      onFilesSelected(selectedFiles, "any", "background");
      onOpenChange(false);
    }
  }, [selectedFiles]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Annotations</DialogTitle>
          <DialogDescription>
            Drop or select annotation files — format is auto-detected.
          </DialogDescription>
        </DialogHeader>

        <UploadCard
          title="Add Annotations"
          description="Drag and drop your annotation files here, or click to browse."
          accept=".json"
          maxSize={100}
          onFilesSelected={setSelectedFiles}
          type="annotations"
        />
      </DialogContent>
    </Dialog>
  );
}
