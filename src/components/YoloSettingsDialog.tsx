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
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Settings, Wand2 } from "lucide-react";
import { YoloAugmentationsDialog } from "./YoloAugmentationsDialog";
import { buildYoloModelSize } from "@/utils/trainingCloneSettings";

interface YoloSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsUpdate: (settings: any) => void;
  currentSettings?: any;
}

const YOLO_TRAIN_SIZES: Record<string, string[]> = {
  yolo8: ['n', 's', 'm', 'l', 'x'],
  yolov8: ['n', 's', 'm', 'l', 'x'],
  yolo11: ['n', 's', 'm', 'l', 'x'],
  yolo26: ['n', 's', 'm', 'l', 'x'],
};

function normalizeYoloVersion(version: string): string {
  const v = (version || '').toLowerCase();
  if (v === 'yolo8') return 'yolov8';
  if (v === 'yolo_nas' || v === 'yolonas') return 'yolo11';
  return version;
}

const SIZE_LABELS: Record<string, string> = {
  n: 'Nano (n) - Fastest',
  s: 'Small (s) - Balanced',
  m: 'Medium (m)',
  l: 'Large (l) - Most Accurate',
  x: 'Extra Large (x)',
};

export function YoloSettingsDialog({ open, onOpenChange, onSettingsUpdate, currentSettings }: YoloSettingsDialogProps) {
  const [version, setVersion] = useState('yolo11');
  const [size, setSize] = useState('n');
  const [task, setTask] = useState('segmentation');
  const [epochs, setEpochs] = useState(100);
  const [batchSize, setBatchSize] = useState(16);
  const [imageSize, setImageSize] = useState(640);
  const [device, setDevice] = useState('0');
  const [patience, setPatience] = useState(50);
  const [optimizer, setOptimizer] = useState('auto');
  const [learningRate, setLearningRate] = useState(0.01);
  const [momentum, setMomentum] = useState(0.937);
  const [weightDecay, setWeightDecay] = useState(0.0005);
  const [savePeriod, setSavePeriod] = useState(-1);
  const [showAugmentations, setShowAugmentations] = useState(false);
  const [augmentationSettings, setAugmentationSettings] = useState<any>({});

  // Sync local state from parent's currentSettings each time dialog opens
  useEffect(() => {
    if (!open) return;
    const s = currentSettings || {};
    if (s.version) setVersion(s.version);
    if (s.size) setSize(s.size);
    if (s.task) setTask(s.task);
    if (s.epochs !== undefined) setEpochs(Number(s.epochs));
    if (s.batchSize !== undefined) setBatchSize(Number(s.batchSize));
    if (s.imageSize !== undefined) setImageSize(Number(s.imageSize));
    if (s.device !== undefined) setDevice(String(s.device));
    if (s.patience !== undefined) setPatience(Number(s.patience));
    if (s.optimizer) setOptimizer(s.optimizer);
    if (s.learningRate !== undefined) setLearningRate(Number(s.learningRate));
    if (s.momentum !== undefined) setMomentum(Number(s.momentum));
    if (s.weightDecay !== undefined) setWeightDecay(Number(s.weightDecay));
    if (s.savePeriod !== undefined) setSavePeriod(Number(s.savePeriod));
    if (s.augmentations) setAugmentationSettings(s.augmentations);
  }, [open, currentSettings]);

  const allowedSizes = YOLO_TRAIN_SIZES[version] || YOLO_TRAIN_SIZES.yolo11;
  useEffect(() => {
    const allowed = YOLO_TRAIN_SIZES[version] || YOLO_TRAIN_SIZES.yolo11;
    if (!allowed.includes(size)) {
      setSize(allowed[0]);
    }
  }, [version]);

  const handleSave = () => {
    // Construct model file name based on version, size, and task
    const normalizedVersion = normalizeYoloVersion(version);
    const modelSize = buildYoloModelSize(normalizedVersion, size, task as "detection" | "segmentation" | "classification");

    const settings = {
      version: normalizedVersion,
      size,
      task,
      modelSize,
      epochs,
      batchSize,
      imageSize,
      device,
      patience,
      optimizer,
      learningRate,
      momentum,
      weightDecay,
      savePeriod,
      augmentations: augmentationSettings,
    };
    onSettingsUpdate(settings);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto bg-background z-[60]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            YOLO Settings
          </DialogTitle>
          <DialogDescription>
            Configure YOLO model parameters for training.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Version Selection */}
          <div className="space-y-3">
            <Label>YOLO Version</Label>
            <Select value={version} onValueChange={setVersion}>
              <SelectTrigger className="bg-background z-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md z-[70]">
                <SelectItem value="yolo8">YOLOv8</SelectItem>
                <SelectItem value="yolo11">YOLOv11</SelectItem>
                <SelectItem value="yolo26">YOLO26</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Model Size */}
          <div className="space-y-3">
            <Label>Model Size</Label>
            <RadioGroup value={size} onValueChange={setSize} className="flex flex-wrap gap-4">
              {allowedSizes.map((sz) => (
                <div key={sz} className="flex items-center space-x-2">
                  <RadioGroupItem value={sz} id={`size-${sz}`} />
                  <Label htmlFor={`size-${sz}`} className="text-sm">
                    {SIZE_LABELS[sz] ?? sz}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Task Type */}
          <div className="space-y-3">
            <Label>Task Type</Label>
            <RadioGroup value={task} onValueChange={setTask} className="space-y-2">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="detection" id="task-detection" />
                <Label htmlFor="task-detection" className="text-sm">
                  Object Detection - Detect and classify objects with bounding boxes
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="segmentation" id="task-segmentation" />
                <Label htmlFor="task-segmentation" className="text-sm">
                  Instance Segmentation - Detect objects and create pixel-level masks
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="classification" id="task-classification" />
                <Label htmlFor="task-classification" className="text-sm">
                  Image Classification - Classify entire images
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Training Parameters */}
          <div className="space-y-4">
            <Label className="text-base font-medium">Training Parameters</Label>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="epochs" className="text-sm">Epochs</Label>
                <Input
                  id="epochs"
                  type="number"
                  min={1}
                  value={epochs}
                  onChange={(e) => setEpochs(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="batchSize" className="text-sm">Batch Size</Label>
                <Input
                  id="batchSize"
                  type="number"
                  min={1}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="imageSize" className="text-sm">Image Size</Label>
                <Input
                  id="imageSize"
                  type="number"
                  min={32}
                  step={32}
                  value={imageSize}
                  onChange={(e) => setImageSize(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="device" className="text-sm">Device (GPU/CPU)</Label>
                <Input
                  id="device"
                  type="text"
                  value={device}
                  onChange={(e) => setDevice(e.target.value)}
                  placeholder="0 for GPU, cpu for CPU"
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="patience" className="text-sm">Patience (Early Stopping)</Label>
                <Input
                  id="patience"
                  type="number"
                  min={1}
                  value={patience}
                  onChange={(e) => setPatience(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="optimizer" className="text-sm">Optimizer</Label>
                <Select value={optimizer} onValueChange={setOptimizer}>
                  <SelectTrigger className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background border shadow-md z-[70]">
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="SGD">SGD</SelectItem>
                    <SelectItem value="Adam">Adam</SelectItem>
                    <SelectItem value="AdamW">AdamW</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="learningRate" className="text-sm">Learning Rate</Label>
                <Input
                  id="learningRate"
                  type="number"
                  step={0.001}
                  min={0.0001}
                  value={learningRate}
                  onChange={(e) => setLearningRate(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="momentum" className="text-sm">Momentum</Label>
                <Input
                  id="momentum"
                  type="number"
                  step={0.001}
                  min={0}
                  max={1}
                  value={momentum}
                  onChange={(e) => setMomentum(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="weightDecay" className="text-sm">Weight Decay</Label>
                <Input
                  id="weightDecay"
                  type="number"
                  step={0.0001}
                  min={0}
                  value={weightDecay}
                  onChange={(e) => setWeightDecay(Number(e.target.value))}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="savePeriod" className="text-sm">
                  Save Checkpoint Every N Epochs
                </Label>
                <Input
                  id="savePeriod"
                  type="number"
                  min={-1}
                  value={savePeriod}
                  onChange={(e) => setSavePeriod(Number(e.target.value))}
                  placeholder="-1 for only best & last"
                  className="bg-background"
                />
                <p className="text-xs text-muted-foreground">
                  Set to -1 to save only best and last models. Set to a positive number (e.g., 10) to save checkpoints every N epochs.
                </p>
              </div>
            </div>
          </div>

          {/* Augmentations Section */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Data Augmentations</Label>
            <p className="text-sm text-muted-foreground">
              Configure augmentation parameters to improve model generalization
            </p>
            <Button
              variant="outline"
              onClick={() => setShowAugmentations(true)}
              className="w-full"
            >
              <Wand2 className="w-4 h-4 mr-2" />
              Configure Augmentations
              {Object.keys(augmentationSettings).length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground">
                  (Custom settings applied)
                </span>
              )}
            </Button>
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

      {/* Augmentations Dialog */}
      <YoloAugmentationsDialog
        open={showAugmentations}
        onOpenChange={setShowAugmentations}
        onSettingsUpdate={setAugmentationSettings}
        currentSettings={augmentationSettings}
      />
    </Dialog>
  );
}