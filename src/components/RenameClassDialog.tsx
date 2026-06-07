import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnnotationSample } from "@/utils/annotations";

interface RenameClassDialogProps {
  isOpen: boolean;
  onClose: () => void;
  className: string;
  annotations: AnnotationSample[];
  onRename: (oldClassName: string, newClassName: string) => void;
}

export function RenameClassDialog({
  isOpen,
  onClose,
  className,
  annotations,
  onRename,
}: RenameClassDialogProps) {
  const [newClassName, setNewClassName] = useState(className);
  const classCount = annotations.filter(ann => ann.className === className).length;

  const handleRename = () => {
    if (newClassName.trim() && newClassName !== className) {
      onRename(className, newClassName.trim());
      onClose();
    }
  };

  const handleClose = () => {
    setNewClassName(className);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="bg-gray-900 text-white border-gray-700">
        <DialogHeader>
          <DialogTitle>Rename Class</DialogTitle>
          <DialogDescription className="text-gray-400">
            Rename "{className}" class. This will affect {classCount} annotation{classCount !== 1 ? 's' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="newClassName" className="text-right text-gray-300">
              New Name
            </Label>
            <Input
              id="newClassName"
              value={newClassName}
              onChange={(e) => setNewClassName(e.target.value)}
              className="col-span-3 bg-gray-800 border-gray-700 text-white"
              placeholder="Enter new class name"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleRename}
            disabled={!newClassName.trim() || newClassName === className}
          >
            Rename Class
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}