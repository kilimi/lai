import { AnnotationSample } from "@/utils/annotations";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";

interface DeleteClassDialogProps {
  isOpen: boolean;
  onClose: () => void;
  className: string;
  annotations: AnnotationSample[];
  onDelete: (className: string) => void;
}

/**
 * Backwards-compatible wrapper around the shared ConfirmDeleteDialog so every
 * "delete X?" prompt across the app uses the same UI.
 */
export function DeleteClassDialog({
  isOpen,
  onClose,
  className,
  annotations,
  onDelete,
}: DeleteClassDialogProps) {
  const classCount = annotations.filter((ann) => ann.className === className).length;

  return (
    <ConfirmDeleteDialog
      open={isOpen}
      onOpenChange={(open) => !open && onClose()}
      entity="class"
      itemName={className}
      consequences={
        classCount > 0
          ? [`${classCount} annotation${classCount !== 1 ? "s" : ""} using this class will also be removed.`]
          : undefined
      }
      confirmLabel="Delete class"
      onConfirm={() => {
        onDelete(className);
        onClose();
      }}
    />
  );
}
