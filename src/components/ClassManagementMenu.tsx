import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Edit3, Trash2, Merge } from "lucide-react";
import { AnnotationSample } from "@/utils/annotations";
import { RenameClassDialog } from "./RenameClassDialog";
import { DeleteClassDialog } from "./DeleteClassDialog";
import { MergeClassesDialog } from "./MergeClassesDialog";

interface ClassManagementMenuProps {
  className: string;
  annotations: AnnotationSample[];
  availableClasses: string[];
  onRenameClass: (oldClassName: string, newClassName: string) => void;
  onDeleteClass: (className: string) => void;
  onMergeClasses: (sourceClassName: string, targetClassName: string) => void;
}

export function ClassManagementMenu({
  className,
  annotations,
  availableClasses,
  onRenameClass,
  onDeleteClass,
  onMergeClasses,
}: ClassManagementMenuProps) {
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMergeDialog, setShowMergeDialog] = useState(false);

  const canMerge = availableClasses.length > 1;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6">
            <MoreHorizontal className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-gray-800 border-gray-700 z-50">
          <DropdownMenuItem
            onClick={() => setShowRenameDialog(true)}
            className="text-white hover:bg-gray-700 focus:bg-gray-700"
          >
            <Edit3 className="h-4 w-4 mr-2" />
            Rename Class
          </DropdownMenuItem>
          {canMerge && (
            <DropdownMenuItem
              onClick={() => setShowMergeDialog(true)}
              className="text-white hover:bg-gray-700 focus:bg-gray-700"
            >
              <Merge className="h-4 w-4 mr-2" />
              Merge Classes
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => setShowDeleteDialog(true)}
            className="text-red-400 hover:bg-gray-700 focus:bg-gray-700"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Class
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameClassDialog
        isOpen={showRenameDialog}
        onClose={() => setShowRenameDialog(false)}
        className={className}
        annotations={annotations}
        onRename={onRenameClass}
      />

      <DeleteClassDialog
        isOpen={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        className={className}
        annotations={annotations}
        onDelete={onDeleteClass}
      />

      <MergeClassesDialog
        open={showMergeDialog}
        onOpenChange={() => setShowMergeDialog(false)}
        classStats={availableClasses.map(cls => ({ className: cls, count: 0, color: '#000000' }))}
        onMerge={onMergeClasses}
      />
    </>
  );
}