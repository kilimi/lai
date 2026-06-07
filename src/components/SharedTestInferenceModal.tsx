import { useState, useRef, useLayoutEffect, ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, Image as ImageIcon, Loader2, AlertCircle } from "lucide-react";
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface InferenceResult {
  predictions: Array<{
    class?: string;
    class_id?: number;
    confidence: number;
    bbox: [number, number, number, number];
    segmentation?: number[][];
  }>;
  image_url?: string;
  error?: string;
}

interface SharedTestInferenceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onRunInference: (image: File) => Promise<InferenceResult>;
  additionalControls?: ReactNode;
}

export function SharedTestInferenceModal({
  open,
  onOpenChange,
  title,
  description,
  onRunInference,
  additionalControls,
}: SharedTestInferenceModalProps) {
  const { toast } = useToast();
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classFilters, setClassFilters] = useState<Record<string, { enabled: boolean; threshold: number }>>({});
  const [showBbox, setShowBbox] = useState<boolean>(true);
  const [showMask, setShowMask] = useState<boolean>(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: "Invalid file",
          description: "Please select an image file",
          variant: "destructive",
        });
        return;
      }
      setSelectedImage(file);
      setResult(null);
      setError(null);
      
      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleRunInference = async () => {
    if (!selectedImage) {
      toast({
        title: "No image selected",
        description: "Please select an image to test",
        variant: "destructive",
      });
      return;
    }

    setIsRunning(true);
    setError(null);
    setResult(null);

    try {
      const inferenceResult = await onRunInference(selectedImage);
      setResult(inferenceResult);
      
      // Initialize class filters with all classes found
      const classSet = new Set<string>();
      if (inferenceResult.predictions && Array.isArray(inferenceResult.predictions)) {
        inferenceResult.predictions.forEach((pred: any) => {
          const className = pred.class || (pred.class_id !== undefined ? `Class ${pred.class_id}` : 'Unknown');
          if (className) classSet.add(className);
        });
      }
      
      const initialFilters: Record<string, { enabled: boolean; threshold: number }> = {};
      classSet.forEach(className => {
        initialFilters[className] = { enabled: true, threshold: 0.25 };
      });
      setClassFilters(initialFilters);
      
      toast({
        title: "Inference completed",
        description: `Found ${inferenceResult.predictions?.length || 0} predictions`,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to run inference';
      setError(errorMessage);
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleClose = () => {
    setSelectedImage(null);
    setImagePreview(null);
    setResult(null);
    setError(null);
    setClassFilters({});
    onOpenChange(false);
  };

  // Get filtered predictions based on class filters and thresholds
  const getFilteredPredictions = () => {
    if (!result?.predictions || result.predictions.length === 0) return [];
    
    // If no filters are set up yet, return all predictions
    if (Object.keys(classFilters).length === 0) {
      return result.predictions;
    }
    
    return result.predictions.filter(pred => {
      const className = pred.class || (pred.class_id !== undefined ? `Class ${pred.class_id}` : 'Unknown');
      const filter = classFilters[className];
      
      // If no filter exists for this class, don't show it (unless filters are empty)
      if (!filter) return false;
      
      // If filter is disabled, don't show it
      if (!filter.enabled) return false;
      
      // Ensure confidence is in 0-1 range (handle both 0-1 and 0-100 formats)
      const confidence = pred.confidence > 1 ? pred.confidence / 100 : pred.confidence;
      return confidence >= filter.threshold;
    });
  };

  // Get filtered predictions (memoized)
  const filteredPredictions = result ? getFilteredPredictions() : [];

  // Draw annotations on canvas overlay
  useLayoutEffect(() => {
    if (!result || !imagePreview || !canvasRef.current || !imageRef.current) return;
    
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawAnnotations = () => {
      // Wait for image to be loaded
      if (!img.complete || img.naturalWidth === 0) {
        setTimeout(drawAnnotations, 100);
        return;
      }

      // Set canvas size to match displayed image size
      const rect = img.getBoundingClientRect();
      const displayWidth = rect.width;
      const displayHeight = rect.height;
      
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Calculate scale factors (displayed size / natural size)
      const scaleX = displayWidth / img.naturalWidth;
      const scaleY = displayHeight / img.naturalHeight;

      // Draw each filtered prediction
      filteredPredictions.forEach((pred) => {
        if (!pred.bbox || pred.bbox.length < 4) return;
        
        const [x, y, w, h] = pred.bbox;
        
        // Scale coordinates
        const canvasX = x * scaleX;
        const canvasY = y * scaleY;
        const canvasW = w * scaleX;
        const canvasH = h * scaleY;

        // Draw segmentation mask if available and enabled
        if (showMask && pred.segmentation && pred.segmentation.length > 0 && pred.segmentation[0]) {
          const polygon = pred.segmentation[0];
          ctx.beginPath();
          
          // Draw polygon from segmentation coordinates
          for (let i = 0; i < polygon.length; i += 2) {
            const px = polygon[i] * scaleX;
            const py = polygon[i + 1] * scaleY;
            if (i === 0) {
              ctx.moveTo(px, py);
            } else {
              ctx.lineTo(px, py);
            }
          }
          ctx.closePath();
          
          // Fill mask with semi-transparent color
          ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
          ctx.fill();
          
          // Draw mask outline
          ctx.strokeStyle = '#00ff00';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        
        // Draw bounding box if enabled
        if (showBbox) {
          ctx.strokeStyle = '#00ff00';
          ctx.lineWidth = 2;
          ctx.strokeRect(canvasX, canvasY, canvasW, canvasH);
        }

        // Draw label background
        const className = pred.class || (pred.class_id !== undefined ? `Class ${pred.class_id}` : 'Unknown');
        const confidence = pred.confidence > 1 ? pred.confidence : pred.confidence * 100;
        const label = `${className}: ${confidence.toFixed(1)}%`;
        ctx.font = 'bold 12px Arial';
        const metrics = ctx.measureText(label);
        const labelWidth = metrics.width;
        const labelHeight = 18;
        
        ctx.fillStyle = 'rgba(0, 255, 0, 0.9)';
        ctx.fillRect(canvasX, Math.max(0, canvasY - labelHeight), labelWidth + 8, labelHeight);

        // Draw label text
        ctx.fillStyle = '#000000';
        ctx.fillText(label, canvasX + 4, Math.max(labelHeight - 4, canvasY - 4));
      });
    };

    // Wait for image to load
    if (img.complete) {
      drawAnnotations();
    } else {
      img.onload = drawAnnotations;
    }

    // Also redraw on window resize
    const handleResize = () => {
      if (img.complete) {
        drawAnnotations();
      }
    };
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      if (img.onload) {
        img.onload = null;
      }
    };
  }, [result, imagePreview, filteredPredictions, showBbox, showMask]);

  const handleClassFilterToggle = (className: string, enabled: boolean) => {
    setClassFilters(prev => ({
      ...prev,
      [className]: { ...prev[className], enabled }
    }));
  };

  const handleThresholdChange = (className: string, threshold: number) => {
    setClassFilters(prev => ({
      ...prev,
      [className]: { ...prev[className], threshold: Math.max(0, Math.min(1, threshold)) }
    }));
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Image Upload */}
          <div className="space-y-2">
            <Label htmlFor="test-image">Test Image</Label>
            <div className="flex items-center gap-4">
              <input
                ref={fileInputRef}
                id="test-image"
                type="file"
                accept="image/*"
                onChange={handleImageSelect}
                className="hidden"
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRunning}
              >
                <Upload className="h-4 w-4 mr-2" />
                Select Image
              </Button>
              {selectedImage && (
                <span className="text-sm text-muted-foreground">
                  {selectedImage.name}
                </span>
              )}
            </div>
          </div>

          {/* Additional Controls (e.g., checkpoint selector) */}
          {additionalControls}

          {/* Image Preview with Annotations */}
          {imagePreview && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Preview with Annotations</Label>
                {result && (
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="show-bbox"
                        checked={showBbox}
                        onCheckedChange={(checked) => setShowBbox(checked as boolean)}
                      />
                      <Label htmlFor="show-bbox" className="text-sm cursor-pointer">
                        Show BBox
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="show-mask"
                        checked={showMask}
                        onCheckedChange={(checked) => setShowMask(checked as boolean)}
                      />
                      <Label htmlFor="show-mask" className="text-sm cursor-pointer">
                        Show Mask
                      </Label>
                    </div>
                  </div>
                )}
              </div>
              <div className="border rounded-lg p-4 bg-muted/50">
                <div className="relative inline-block">
                  <img
                    ref={imageRef}
                    src={imagePreview}
                    alt="Preview"
                    className="max-w-full max-h-96 mx-auto rounded block"
                  />
                  {result && (
                    <canvas
                      ref={canvasRef}
                      className="absolute top-0 left-0 pointer-events-none"
                      style={{ 
                        width: '100%', 
                        height: '100%',
                        objectFit: 'contain'
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Run Inference Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleRunInference}
              disabled={!selectedImage || isRunning}
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Running Inference...
                </>
              ) : (
                <>
                  <ImageIcon className="h-4 w-4 mr-2" />
                  Run Inference
                </>
              )}
            </Button>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
              <div className="flex items-center gap-2 text-red-400">
                <AlertCircle className="h-5 w-5" />
                <span className="font-medium">Error</span>
              </div>
              <p className="mt-2 text-sm text-red-300">{error}</p>
            </div>
          )}

          {/* Class Filters */}
          {result && result.predictions && result.predictions.length > 0 && Object.keys(classFilters).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Class Filters</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(classFilters).map(([className, filter]) => {
                  const classCount = result.predictions?.filter(p => {
                    const predClass = p.class || (p.class_id !== undefined ? `Class ${p.class_id}` : 'Unknown');
                    return predClass === className;
                  }).length || 0;
                  const visibleCount = filteredPredictions.filter(p => {
                    const predClass = p.class || (p.class_id !== undefined ? `Class ${p.class_id}` : 'Unknown');
                    return predClass === className;
                  }).length;
                  
                  return (
                    <div key={className} className="flex items-center gap-4 p-2 border rounded">
                      <div className="flex items-center gap-2 flex-1">
                        <Checkbox
                          id={`filter-${className}`}
                          checked={filter.enabled}
                          onCheckedChange={(checked) => 
                            handleClassFilterToggle(className, checked as boolean)
                          }
                        />
                        <Label 
                          htmlFor={`filter-${className}`}
                          className="font-medium cursor-pointer flex-1"
                        >
                          {className}
                          <span className="text-xs text-muted-foreground ml-2">
                            ({visibleCount}/{classCount})
                          </span>
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`threshold-${className}`} className="text-xs text-muted-foreground">
                          Min:
                        </Label>
                        <Input
                          id={`threshold-${className}`}
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={filter.threshold}
                          onChange={(e) => 
                            handleThresholdChange(className, parseFloat(e.target.value) || 0)
                          }
                          className="w-20 h-8 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">
                          ({(filter.threshold * 100).toFixed(0)}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Results Display */}
          {result && (
            <div className="space-y-4">
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                <h3 className="font-semibold mb-3">
                  Inference Results ({filteredPredictions.length} visible / {result.predictions?.length || 0} total)
                </h3>

                <div className="space-y-2">
                  <Label>Predictions</Label>
                  {!result.predictions || result.predictions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No predictions found
                    </p>
                  ) : filteredPredictions.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {filteredPredictions.map((pred, idx) => (
                        <div
                          key={idx}
                          className="bg-background rounded p-3 border"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium">{pred.class}</span>
                            <span className="text-sm font-semibold text-green-400">
                              {(pred.confidence * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            BBox: [{pred.bbox.map(b => b.toFixed(1)).join(', ')}]
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No predictions match the current filters
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
