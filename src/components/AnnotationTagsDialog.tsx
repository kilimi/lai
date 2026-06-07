import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TagsInput } from '@/components/TagsInput';
import { Tag } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface AnnotationTagsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  annotationFileName: string;
  initialTags: string[];
  onSaveTags: (tags: string[]) => Promise<void>;
}

export function AnnotationTagsDialog({
  open,
  onOpenChange,
  annotationFileName,
  initialTags,
  onSaveTags
}: AnnotationTagsDialogProps) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Reset tags when dialog opens
  React.useEffect(() => {
    if (open) {
      setTags(initialTags);
    }
  }, [open, initialTags]);

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await onSaveTags(tags);
      toast({
        title: "Tags updated",
        description: `Tags for "${annotationFileName}" have been saved.`,
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save tags",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setTags(initialTags);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-gray-900 text-white border-gray-700">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Manage Tags
          </DialogTitle>
          <div className="text-sm text-gray-400">
            {annotationFileName}
          </div>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium text-gray-300 mb-2 block">
              Tags
            </label>
            <TagsInput
              tags={tags}
              onTagsChange={setTags}
              placeholder="Add tags for organization and search..."
              className="min-h-[80px] p-3 border border-gray-700 rounded-md bg-gray-800"
              maxTags={10}
            />
          </div>
          
          <div className="text-xs text-gray-500">
            Use tags to categorize and search annotation files. Common tags include: training, validation, production, reviewed, etc.
          </div>
        </div>
        
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isLoading}
            className="border-gray-700 bg-gray-800 hover:bg-gray-700 text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isLoading}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {isLoading ? "Saving..." : "Save Tags"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
