import { useState, useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent } from '@/components/ui/card';
import { Upload, FolderOpen, File, CheckCircle, AlertCircle, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export interface ChunkedImageCollectionUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilesUploaded: (totalUploaded: number) => void;
  onUploadChunk: (files: File[]) => Promise<void>;
  chunkSize?: number;
  collectionName?: string;
}

export const ChunkedImageCollectionUploadDialog = ({ 
  open, 
  onOpenChange, 
  onFilesUploaded,
  onUploadChunk,
  chunkSize = 1000,
  collectionName = "collection"
}: ChunkedImageCollectionUploadDialogProps) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const imageFiles = files.filter(file => 
      file.type.startsWith('image/') || 
      file.name.toLowerCase().endsWith('.tif') || 
      file.name.toLowerCase().endsWith('.tiff')
    );
    setSelectedFiles(prev => [...prev, ...imageFiles]);
  };

  const handleSelectFiles = () => {
    fileInputRef.current?.click();
  };

  const handleSelectFolder = () => {
    folderInputRef.current?.click();
  };

  const createChunks = (files: File[]): File[][] => {
    const chunks: File[][] = [];
    for (let i = 0; i < files.length; i += chunkSize) {
      chunks.push(files.slice(i, i + chunkSize));
    }
    return chunks;
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadedCount(0);
    setFailedCount(0);

    const chunks = createChunks(selectedFiles);
    setTotalChunks(chunks.length);

    let totalUploaded = 0;
    let totalFailed = 0;

    // Show initial toast with upload information
    toast({
      title: "Starting Upload",
      description: `Uploading ${selectedFiles.length} images to ${collectionName} in ${chunks.length} chunks`,
    });

    for (let i = 0; i < chunks.length; i++) {
      setCurrentChunk(i + 1);
      
      try {
        await onUploadChunk(chunks[i]);
        totalUploaded += chunks[i].length;
        setUploadedCount(totalUploaded);
        
        toast({
          title: "Chunk uploaded",
          description: `Uploaded chunk ${i + 1}/${chunks.length} (${chunks[i].length} images) to ${collectionName}`,
        });
      } catch (error) {
        console.error(`Failed to upload chunk ${i + 1}:`, error);
        totalFailed += chunks[i].length;
        setFailedCount(totalFailed);
        
        toast({
          title: "Upload failed",
          description: `Failed to upload chunk ${i + 1}/${chunks.length} to ${collectionName}`,
          variant: "destructive",
        });
      }

      setUploadProgress(((i + 1) / chunks.length) * 100);
    }

    setIsUploading(false);

    if (totalFailed === 0) {
      toast({
        title: "Upload complete",
        description: `Successfully uploaded ${totalUploaded} images to ${collectionName} in ${chunks.length} chunks`,
      });
    } else {
      toast({
        title: "Upload completed with errors",
        description: `Uploaded ${totalUploaded} images to ${collectionName}, ${totalFailed} failed`,
        variant: "destructive",
      });
    }

    onFilesUploaded(totalUploaded);
    handleClose();
  };

  const handleClose = () => {
    if (isUploading) {
      // Prevent closing during upload
      return;
    }
    setSelectedFiles([]);
    setUploadProgress(0);
    setCurrentChunk(0);
    setTotalChunks(0);
    setUploadedCount(0);
    setFailedCount(0);
    onOpenChange(false);
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const expectedChunks = Math.ceil(selectedFiles.length / chunkSize);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Images to {collectionName}</DialogTitle>
          <DialogDescription>
            Select image files or folders to upload to the {collectionName} collection. 
            Images will be uploaded in chunks of {chunkSize} for better performance and reliability.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isUploading && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Button
                  variant="outline"
                  onClick={handleSelectFiles}
                  className="h-32 flex flex-col items-center justify-center gap-2"
                >
                  <File className="h-8 w-8" />
                  <span>Select Files</span>
                </Button>
                
                <Button
                  variant="outline"
                  onClick={handleSelectFolder}
                  className="h-32 flex flex-col items-center justify-center gap-2"
                >
                  <FolderOpen className="h-8 w-8" />
                  <span>Select Folder</span>
                </Button>
              </div>

              {selectedFiles.length > 0 && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {selectedFiles.length} images selected
                        </span>
                        <span className="text-sm text-muted-foreground">
                          Will upload in {expectedChunks} chunks
                        </span>
                      </div>
                      
                      <div className="max-h-32 overflow-y-auto space-y-1">
                        {selectedFiles.slice(0, 10).map((file, index) => (
                          <div key={index} className="flex items-center justify-between text-sm">
                            <span className="truncate flex-1 mr-2">{file.name}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeFile(index)}
                              className="h-6 w-6 p-0 hover:bg-red-100 hover:text-red-600"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                        {selectedFiles.length > 10 && (
                          <div className="text-sm text-muted-foreground text-center">
                            ... and {selectedFiles.length - 10} more files
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {isUploading && (
            <Card>
              <CardContent className="pt-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      Uploading to {collectionName}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      Chunk {currentChunk} of {totalChunks}
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      {uploadedCount > 0 && (
                        <div className="flex items-center gap-1 text-green-600">
                          <CheckCircle className="h-4 w-4" />
                          <span className="text-sm">{uploadedCount} uploaded</span>
                        </div>
                      )}
                      {failedCount > 0 && (
                        <div className="flex items-center gap-1 text-red-600">
                          <AlertCircle className="h-4 w-4" />
                          <span className="text-sm">{failedCount} failed</span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <Progress value={uploadProgress} className="w-full" />
                  
                  <div className="text-sm text-muted-foreground text-center">
                    {Math.round(uploadProgress)}% complete
                    {totalChunks > 1 && (
                      <div className="mt-1">
                        Processing in {totalChunks} chunks of up to {chunkSize} images each
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button 
            variant="outline" 
            onClick={handleClose} 
            disabled={isUploading}
            className={isUploading ? "opacity-50 cursor-not-allowed" : ""}
          >
            {isUploading ? 'Upload in Progress...' : 'Cancel'}
          </Button>
          {!isUploading && selectedFiles.length > 0 && (
            <Button onClick={handleUpload}>
              <Upload className="h-4 w-4 mr-2" />
              Upload {selectedFiles.length} Images
            </Button>
          )}
        </DialogFooter>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.tif,.tiff"
          className="hidden"
          onChange={handleFileChange}
        />
        
        <input
          ref={folderInputRef}
          type="file"
          {...({ webkitdirectory: "" } as any)}
          multiple
          accept="image/*,.tif,.tiff"
          className="hidden"
          onChange={handleFileChange}
        />
      </DialogContent>
    </Dialog>
  );
};
