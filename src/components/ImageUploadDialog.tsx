import { useState, useRef } from "react";
import { 
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, Upload, Image, Folder } from "lucide-react";

export interface ImageUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilesSelected: (files: File[]) => void;
}

export const ImageUploadDialog = ({ 
  open, 
  onOpenChange,
  onFilesSelected 
}: ImageUploadDialogProps) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files?.length) return;
    
    const fileArray = Array.from(files);
    
    // Filter for image files - include TIF/TIFF support
    const imageFiles = fileArray.filter(file => {
      const fileName = file.name.toLowerCase();
      const isImageType = file.type.startsWith('image/');
      const isTiffFile = fileName.endsWith('.tif') || fileName.endsWith('.tiff');
      return isImageType || isTiffFile;
    });
    
    setSelectedFiles(prev => [...prev, ...imageFiles]);
  };

  const handleSelectFiles = () => {
    setIsSelectingFolder(false);
    fileInputRef.current?.click();
  };

  const handleSelectFolder = () => {
    setIsSelectingFolder(true);
    folderInputRef.current?.click();
  };

  const handleSubmit = () => {
    onFilesSelected(selectedFiles);
    handleClose();
  };

  const handleClose = () => {
    setSelectedFiles([]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-gray-900 border-gray-700 text-white">
        <DialogHeader>
          <DialogTitle>Upload Images</DialogTitle>
          <DialogDescription className="text-gray-400">
            Upload images to add to your dataset
          </DialogDescription>
        </DialogHeader>
        
        <div className="my-4">
          {/* File selection input */}
          <input 
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            accept="image/*,.tif,.tiff"
            multiple
          />
          
          {/* Folder selection input */}
          <input 
            type="file"
            ref={folderInputRef}
            onChange={handleFileChange}
            className="hidden"
            accept="image/*,.tif,.tiff"
            {...({ webkitdirectory: "true" } as any)}
            multiple
          />
          
          <div className="space-y-4">
            {/* Selection buttons */}
            <div className="flex gap-4">
              <div 
                className="flex-1 border-2 border-dashed border-gray-700 rounded-lg p-8 text-center hover:border-gray-600 transition-colors cursor-pointer"
                onClick={handleSelectFiles}
              >
                <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                <p className="text-sm font-medium">Select Files</p>
                <p className="text-xs text-gray-500 mt-1">Choose individual image files</p>
              </div>
              
              <div 
                className="flex-1 border-2 border-dashed border-gray-700 rounded-lg p-8 text-center hover:border-gray-600 transition-colors cursor-pointer"
                onClick={handleSelectFolder}
              >
                <Folder className="mx-auto h-8 w-8 text-gray-400 mb-2" />
                <p className="text-sm font-medium">Select Folder</p>
                <p className="text-xs text-gray-500 mt-1">Choose entire folder with images</p>
              </div>
            </div>
            
            {/* Selected files display */}
            {selectedFiles.length > 0 && (
              <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
                <div className="flex items-center justify-center">
                  <Image className="h-8 w-8 text-gray-400 mb-2" />
                </div>
                <p className="text-center text-lg font-medium">
                  {selectedFiles.length} {selectedFiles.length === 1 ? 'image' : 'images'} selected
                </p>
                <p className="text-center text-sm text-gray-500 mt-1">
                  PNG, JPG, WEBP, TIF/TIFF up to 50MB each. Large batches will be uploaded in chunks of 1000.
                </p>
                <p className="text-center text-xs text-gray-400 mt-2">
                  Files with duplicate names will be saved with collection names (e.g., image_RGB_Images.jpg)
                </p>
              </div>
            )}
          </div>
        </div>
        
        <DialogFooter>
          <Button
            onClick={handleClose}
            variant="outline"
            className="bg-transparent border-gray-700 hover:bg-gray-800 mr-2"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={selectedFiles.length === 0}
            className="bg-blue-600 hover:bg-blue-700"
          >
            Upload {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
