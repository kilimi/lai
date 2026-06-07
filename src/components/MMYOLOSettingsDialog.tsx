import React, { useEffect, useState } from 'react';
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
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, Settings } from "lucide-react";

interface MMYOLOSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsUpdate: (settings: any) => void;
  currentSettings?: any;
  deployTarget?: 'general' | 'edge-drone';
  djiPatchName?: string | null;
  djiPatchUploading?: boolean;
  onDJIPatchUpload?: (file: File | null) => void;
}

export function MMYOLOSettingsDialog({
  open,
  onOpenChange,
  onSettingsUpdate,
  currentSettings,
  deployTarget = 'general',
  djiPatchName,
  djiPatchUploading = false,
  onDJIPatchUpload,
}: MMYOLOSettingsDialogProps) {
  const [optimizer, setOptimizer] = useState('AdamW');
  const [learningRate, setLearningRate] = useState(0.004);
  const [weightDecay, setWeightDecay] = useState(0.05);
  const [savePeriod, setSavePeriod] = useState(-1);
  const [djiWidenFactor025, setDjiWidenFactor025] = useState(false);

  useEffect(() => {
    if (!open) return;
    const s = currentSettings || {};
    if (s.optimizer) setOptimizer(String(s.optimizer));
    if (s.learningRate !== undefined) setLearningRate(Number(s.learningRate));
    if (s.weightDecay !== undefined) setWeightDecay(Number(s.weightDecay));
    if (s.savePeriod !== undefined) setSavePeriod(Number(s.savePeriod));
    setDjiWidenFactor025(s.djiWidenFactor025 === true);
  }, [open, currentSettings]);

  const handleSave = () => {
    const settings = {
      ...(currentSettings || {}),
      optimizer,
      learningRate,
      weightDecay,
      savePeriod,
      djiWidenFactor025,
    };
    onSettingsUpdate(settings);
    onOpenChange(false);
  };

  const isDJIMode = deployTarget === 'edge-drone';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] bg-background z-[60]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            MMYOLO Advanced Settings
          </DialogTitle>
          <DialogDescription>
            {isDJIMode 
              ? 'DJI Drone mode: YOLOv8-S configuration enforced for compatibility.'
              : 'Tune optimizer and checkpoint behavior. Device selection is automatic.'}
          </DialogDescription>
        </DialogHeader>

        {isDJIMode && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-900 dark:text-amber-300 space-y-1">
              <p className="font-medium">DJI Requirements Enforced:</p>
              <ul className="list-disc list-inside space-y-0.5 pl-2">
                <li>Architecture: YOLOv8</li>
                <li>Size: Small (S)</li>
                <li>Max Classes: 10</li>
                <li>Task: Detection only</li>
                <li>MMYolo version: v0.6.0</li>
              </ul>
            </div>
          </div>
        )}

        {isDJIMode && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-start gap-3">
              <Checkbox
                id="dji-widen-factor"
                checked={djiWidenFactor025}
                onCheckedChange={(v) => setDjiWidenFactor025(v === true)}
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label htmlFor="dji-widen-factor" className="text-sm font-medium cursor-pointer">
                  Enable widen_factor=0.25 (4K quantization mode)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Required for DJI on-device quantization and calibration at 4K resolution.
                  Disable to train with the default YOLOv8-S width (widen_factor=0.5) — useful
                  for validating training before enabling quantization-specific settings.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 py-4">

          <div className="space-y-2">
            <Label htmlFor="mmyolo-optimizer">Optimizer</Label>
            <Select value={optimizer} onValueChange={setOptimizer}>
              <SelectTrigger id="mmyolo-optimizer" className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md z-[70]">
                <SelectItem value="AdamW">AdamW</SelectItem>
                <SelectItem value="SGD">SGD</SelectItem>
                <SelectItem value="Adam">Adam</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="mmyolo-lr">Learning Rate</Label>
              <Input
                id="mmyolo-lr"
                type="number"
                min={0.000001}
                step={0.0001}
                value={learningRate}
                onChange={(e) => setLearningRate(Number(e.target.value))}
                className="bg-background"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mmyolo-wd">Weight Decay</Label>
              <Input
                id="mmyolo-wd"
                type="number"
                min={0}
                step={0.0001}
                value={weightDecay}
                onChange={(e) => setWeightDecay(Number(e.target.value))}
                className="bg-background"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="mmyolo-save-period">Save Checkpoint Every N Epochs</Label>
            <Input
              id="mmyolo-save-period"
              type="number"
              min={-1}
              value={savePeriod}
              onChange={(e) => setSavePeriod(Number(e.target.value))}
              className="bg-background"
            />
            <p className="text-xs text-muted-foreground">
              Use -1 to save only best and last checkpoints.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Settings</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
