import { useState, useRef, DragEvent, ChangeEvent } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UploadCloud, FileType, X, Check, AlertCircle } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

interface UploadCardProps {
  title: string;
  description: string;
  accept?: string;
  maxSize?: number; // in MB
  multiple?: boolean;
  onFilesSelected: (files: File[]) => void;
  type?: "images" | "annotations";
}

export function UploadCard({
  title,
  description,
  accept = "*",
  maxSize = 50,
  multiple = true,
  onFilesSelected,
  type = "images",
}: UploadCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  
  const maxSizeBytes = maxSize * 1024 * 1024;
  
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  
  const validateFiles = (fileList: File[]): { valid: File[]; errors: string[] } => {
    const validFiles: File[] = [];
    const newErrors: string[] = [];
    
    for (const file of fileList) {
      // Check file size
      if (file.size > maxSizeBytes) {
        newErrors.push(`"${file.name}" exceeds the maximum size of ${maxSize}MB`);
        continue;
      }
      
      // Check file type based on accept prop
      if (accept !== "*") {
        const acceptedTypes = accept.split(",").map(type => type.trim());
        const fileType = file.type;
        const fileExtension = `.${file.name.split(".").pop()}`;
        
        const isAccepted = acceptedTypes.some(type => {
          if (type.startsWith(".")) {
            return fileExtension.toLowerCase() === type.toLowerCase();
          }
          if (type.endsWith("/*")) {
            const mainType = type.split("/")[0];
            return fileType.startsWith(`${mainType}/`);
          }
          return fileType === type;
        });
        
        if (!isAccepted) {
          newErrors.push(`"${file.name}" has an unsupported file type`);
          continue;
        }
      }
      
      validFiles.push(file);
    }
    
    return { valid: validFiles, errors: newErrors };
  };
  
  const processFiles = (fileList: FileList) => {
    const newFiles = Array.from(fileList);
    const { valid, errors } = validateFiles(newFiles);

    const updatedFiles = [...files, ...valid];
    setFiles(updatedFiles);
    onFilesSelected(updatedFiles);

    if (errors.length > 0) {
      setErrors(errors);
      toast({
        variant: "destructive",
        title: "Upload error",
        description: `${errors.length} file(s) could not be added. Check for details.`,
      });
    }

    if (valid.length > 0) {
      toast({
        title: "Files added",
        description: `${valid.length} file(s) successfully added`,
      });
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };
  
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };
  
  const handleClick = () => {
    if (inputRef.current) {
      inputRef.current.click();
    }
  };

  const removeFile = (index: number) => {
    const updatedFiles = files.filter((_, i) => i !== index);
    setFiles(updatedFiles);
    onFilesSelected(updatedFiles);
  };
  
  const clearErrors = () => {
    setErrors([]);
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        className={cn(
          "relative rounded-lg border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center p-8 text-center",
          isDragging
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-muted-foreground/50"
        )}
      >
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <div className="rounded-full bg-secondary p-2.5">
            <UploadCloud className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-medium text-foreground">{title}</h3>
          <p className="text-sm">{description}</p>
          <p className="text-xs">
            {type === "images" 
              ? "Supports JPG, PNG, WEBP, TIF/TIFF up to 50MB"
              : "Supports JSON files up to 100MB"}
          </p>
          <Button 
            variant="secondary" 
            size="sm" 
            className="mt-2"
            onClick={(e) => {
              e.stopPropagation();
              handleClick();
            }}
          >
            Select files
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          className="hidden"
        />
      </div>
      
      {files.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h4 className="text-sm font-medium mb-2">Selected files ({files.length})</h4>
            <div className="max-h-40 overflow-y-auto space-y-2">
              {files.map((file, index) => (
                <div 
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2 truncate pr-3">
                    <FileType className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      ({(file.size / 1024 / 1024).toFixed(2)} MB)
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(index);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      
      {errors.length > 0 && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium flex items-center text-destructive">
                <AlertCircle className="h-4 w-4 mr-1" />
                Errors ({errors.length})
              </h4>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={clearErrors}
              >
                Clear
              </Button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1 text-sm">
              {errors.map((error, index) => (
                <div 
                  key={index}
                  className="text-destructive text-xs py-1"
                >
                  {error}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
