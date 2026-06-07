import React, { useState, useEffect } from 'react';
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Settings } from "lucide-react";

interface RFDETRSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsUpdate: (settings: any) => void;
  currentSettings?: any;
}

export function RFDETRSettingsDialog({ open, onOpenChange, onSettingsUpdate, currentSettings }: RFDETRSettingsDialogProps) {
  const [variant, setVariant] = useState('rtdetr-l');
  const [imageSize, setImageSize] = useState('640');
  const [epochs, setEpochs] = useState('100');
  const [batchSize, setBatchSize] = useState('16');

  // Sync from parent state when opening
  useEffect(() => {
    if (!open) return;
    const s = currentSettings || {};
    if (s.variant) setVariant(String(s.variant));
    if (s.imageSize !== undefined) setImageSize(String(s.imageSize));
    if (s.epochs !== undefined) setEpochs(String(s.epochs));
    if (s.batchSize !== undefined) setBatchSize(String(s.batchSize));
  }, [open, currentSettings]);

  const handleSave = () => {
    const settings = {
      ...(currentSettings || {}),
      variant,
      imageSize: parseInt(imageSize),
      epochs: parseInt(epochs),
      batchSize: parseInt(batchSize),
    };
    onSettingsUpdate(settings);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] bg-background z-[60]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            RT-DETR Settings
          </DialogTitle>
          <DialogDescription>
            Configure Real-Time Detection Transformer parameters.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Model Variant */}
          <div className="space-y-3">
            <Label>Model Variant</Label>
            <Select value={variant} onValueChange={setVariant}>
              <SelectTrigger className="bg-background z-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md z-[70]">
                <SelectItem value="rtdetr-l">RT-DETR-L - Large (Recommended)</SelectItem>
                <SelectItem value="rtdetr-x">RT-DETR-X - Extra Large (Most Accurate)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Image Size */}
          <div className="space-y-3">
            <Label>Input Image Size</Label>
            <RadioGroup value={imageSize} onValueChange={setImageSize} className="space-y-2">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="480" id="size-480" />
                <Label htmlFor="size-480" className="text-sm">480px - Faster training</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="640" id="size-640" />
                <Label htmlFor="size-640" className="text-sm">640px - Standard</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="800" id="size-800" />
                <Label htmlFor="size-800" className="text-sm">800px - Higher accuracy</Label>
              </div>
            </RadioGroup>
          </div>

          {/* Training Parameters */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="epochs">Epochs</Label>
              <Input
                id="epochs"
                type="number"
                value={epochs}
                onChange={(e) => setEpochs(e.target.value)}
                min="1"
                max="1000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="batch-size">Batch Size</Label>
              <Input
                id="batch-size"
                type="number"
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
                min="1"
                max="64"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
