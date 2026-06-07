import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AnnotationSample } from "@/utils/annotations";
import { Merge } from "lucide-react";

interface GlobalMergeClassesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  annotations: AnnotationSample[];
  availableClasses: string[];
  onMerge: (sourceClassName: string, targetClassName: string) => void;
}

export function GlobalMergeClassesDialog({
  isOpen,
  onClose,
  annotations,
  availableClasses,
  onMerge,
}: GlobalMergeClassesDialogProps) {
  const [sourceClass, setSourceClass] = useState<string>("");
  const [targetClass, setTargetClass] = useState<string>("");
  
  const sourceClassCount = sourceClass ? annotations.filter(ann => ann.className === sourceClass).length : 0;
  const targetClassCount = targetClass ? annotations.filter(ann => ann.className === targetClass).length : 0;
  
  // Filter out the selected source class from available targets
  const mergeTargets = availableClasses.filter(cls => cls !== sourceClass);

  const handleMerge = () => {
    if (sourceClass && targetClass) {
      onMerge(sourceClass, targetClass);
      handleClose();
    }
  };

  const handleClose = () => {
    setSourceClass("");
    setTargetClass("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="bg-gray-900 text-white border-gray-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5 text-blue-500" />
            Merge Classes
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            Select which classes to merge together.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="sourceClass" className="text-right text-gray-300">
              Source Class
            </Label>
            <div className="col-span-3">
              <Select value={sourceClass} onValueChange={setSourceClass}>
                <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                  <SelectValue placeholder="Select class to merge from" />
                </SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700">
                  {availableClasses.map((cls) => {
                    const count = annotations.filter(ann => ann.className === cls).length;
                    return (
                      <SelectItem key={cls} value={cls} className="text-white hover:bg-gray-700">
                        {cls} ({count} annotation{count !== 1 ? 's' : ''})
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="targetClass" className="text-right text-gray-300">
              Target Class
            </Label>
            <div className="col-span-3">
              <Select value={targetClass} onValueChange={setTargetClass} disabled={!sourceClass}>
                <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
                  <SelectValue placeholder="Select class to merge into" />
                </SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700">
                  {mergeTargets.map((cls) => {
                    const count = annotations.filter(ann => ann.className === cls).length;
                    return (
                      <SelectItem key={cls} value={cls} className="text-white hover:bg-gray-700">
                        {cls} ({count} annotation{count !== 1 ? 's' : ''})
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          
          {sourceClass && targetClass && (
            <div className="text-sm text-gray-400 bg-gray-800 p-3 rounded">
              This will merge {sourceClassCount} annotation{sourceClassCount !== 1 ? 's' : ''} from "{sourceClass}" 
              into "{targetClass}" (which currently has {targetClassCount} annotation{targetClassCount !== 1 ? 's' : ''}), 
              resulting in {sourceClassCount + targetClassCount} total annotations for "{targetClass}".
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleMerge}
            disabled={!sourceClass || !targetClass}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Merge className="h-4 w-4 mr-2" />
            Merge Classes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}