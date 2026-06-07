import { useState } from "react";
import { 
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AddImageTabDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTabAdded: (tabName: string) => void;
  existingTabNames: string[];
}

export const AddImageTabDialog = ({ 
  open, 
  onOpenChange,
  onTabAdded,
  existingTabNames
}: AddImageTabDialogProps) => {
  const [tabName, setTabName] = useState("");
  const [error, setError] = useState("");
  
  const handleSubmit = () => {
    const trimmedName = tabName.trim();
    
    if (!trimmedName) {
      setError("Tab name cannot be empty");
      return;
    }
    
    if (existingTabNames.includes(trimmedName)) {
      setError("A tab with this name already exists");
      return;
    }
    
    // Check for reserved names
    const reservedNames = ["RGB Images", "Annotations"];
    if (reservedNames.includes(trimmedName)) {
      setError("This name is reserved. Please choose a different name.");
      return;
    }
    
    onTabAdded(trimmedName);
    handleClose();
  };

  const handleClose = () => {
    setTabName("");
    setError("");
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-gray-900 border-gray-700 text-white">
        <DialogHeader>
          <DialogTitle>Add New Image Tab</DialogTitle>
          <DialogDescription className="text-gray-400">
            Create a new tab to organize different types of images (e.g., "Depth Images", "RGB Images", "Masks")
          </DialogDescription>
        </DialogHeader>
        
        <div className="my-4">
          <Label htmlFor="tab-name" className="text-sm font-medium">
            Tab Name
          </Label>
          <Input
            id="tab-name"
            value={tabName}
            onChange={(e) => {
              setTabName(e.target.value);
              setError("");
            }}
            placeholder="Enter tab name (e.g., Depth Images)"
            className="mt-2 bg-gray-800 border-gray-700 text-white placeholder-gray-400"
            onKeyDown={handleKeyDown}
            autoFocus
          />
          {error && (
            <p className="text-red-400 text-sm mt-2">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            className="border-gray-600 text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            className="bg-blue-600 hover:bg-blue-700"
            disabled={!tabName.trim()}
          >
            Add Tab
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
