import { ReactNode } from "react";
import { Trash2, AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short title, e.g. "Delete dataset?" */
  title?: string;
  /**
   * The thing being deleted, e.g. "dataset", "trained model", "annotation".
   * Used to compose default title/description when those aren't provided.
   */
  entity?: string;
  /** Name of the specific item, shown in bold inside the description. */
  itemName?: string | null;
  /** Optional full description. Overrides the default composed message. */
  description?: ReactNode;
  /** Optional consequences list shown as bullets under the main description. */
  consequences?: ReactNode[];
  /** Optional arbitrary content rendered between the description and footer (e.g. extra checkboxes). */
  extraContent?: ReactNode;
  /** Label for the confirm button. Defaults to "Delete". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Disables confirm + cancel and shows a spinner on confirm. */
  isLoading?: boolean;
  /** Called when user confirms. */
  onConfirm: () => void | Promise<void>;
}

/**
 * Standard "Are you sure?" confirmation used everywhere a user can delete
 * something (datasets, models, exports, evaluations, classes, annotations…).
 * Reuse this instead of building bespoke dialogs or calling window.confirm.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  entity = "item",
  itemName,
  description,
  consequences,
  extraContent,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  isLoading = false,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const resolvedTitle = title ?? `Delete ${entity}?`;
  const resolvedDescription =
    description ?? (
      <>
        Are you sure you want to delete{" "}
        {itemName ? (
          <>
            the {entity} <span className="font-semibold text-foreground">"{itemName}"</span>
          </>
        ) : (
          <>this {entity}</>
        )}
        ? This action cannot be undone.
      </>
    );

  return (
    <AlertDialog open={open} onOpenChange={(o) => !isLoading && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {resolvedTitle}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{resolvedDescription}</p>
              {consequences && consequences.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                  {consequences.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {extraContent}
        <AlertDialogFooter>

          <AlertDialogCancel disabled={isLoading}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isLoading}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4 mr-2" />
            )}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ConfirmDeleteDialog;
