import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Wand2 } from "lucide-react";

interface YoloAugmentationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettingsUpdate: (settings: any) => void;
  currentSettings?: any;
}

export function YoloAugmentationsDialog({ 
  open, 
  onOpenChange, 
  onSettingsUpdate,
  currentSettings = {}
}: YoloAugmentationsDialogProps) {
  // Color augmentations
  const [hsvH, setHsvH] = useState(currentSettings.hsv_h ?? 0.015);
  const [hsvS, setHsvS] = useState(currentSettings.hsv_s ?? 0.7);
  const [hsvV, setHsvV] = useState(currentSettings.hsv_v ?? 0.4);

  // Geometric augmentations
  const [degrees, setDegrees] = useState(currentSettings.degrees ?? 0.0);
  const [translate, setTranslate] = useState(currentSettings.translate ?? 0.1);
  const [scale, setScale] = useState(currentSettings.scale ?? 0.5);
  const [shear, setShear] = useState(currentSettings.shear ?? 0.0);
  const [perspective, setPerspective] = useState(currentSettings.perspective ?? 0.0);
  const [flipud, setFlipud] = useState(currentSettings.flipud ?? 0.0);
  const [fliplr, setFliplr] = useState(currentSettings.fliplr ?? 0.5);

  // Advanced augmentations
  const [mosaic, setMosaic] = useState(currentSettings.mosaic ?? 1.0);
  const [mixup, setMixup] = useState(currentSettings.mixup ?? 0.0);
  const [copyPaste, setCopyPaste] = useState(currentSettings.copy_paste ?? 0.0);
  const [autoAugment, setAutoAugment] = useState(currentSettings.auto_augment ?? 'randaugment');
  const [erasing, setErasing] = useState(currentSettings.erasing ?? 0.4);
  const [cropFraction, setCropFraction] = useState(currentSettings.crop_fraction ?? 1.0);

  // Enable/disable switches
  const [enableColorAug, setEnableColorAug] = useState(currentSettings.enable_color ?? true);
  const [enableGeometricAug, setEnableGeometricAug] = useState(currentSettings.enable_geometric ?? true);
  const [enableAdvancedAug, setEnableAdvancedAug] = useState(currentSettings.enable_advanced ?? true);

  const handleSave = () => {
    const settings = {
      // Only include augmentations if their category is enabled
      ...(enableColorAug && {
        hsv_h: hsvH,
        hsv_s: hsvS,
        hsv_v: hsvV,
      }),
      ...(enableGeometricAug && {
        degrees: degrees,
        translate: translate,
        scale: scale,
        shear: shear,
        perspective: perspective,
        flipud: flipud,
        fliplr: fliplr,
      }),
      ...(enableAdvancedAug && {
        mosaic: mosaic,
        mixup: mixup,
        copy_paste: copyPaste,
        auto_augment: autoAugment,
        erasing: erasing,
        crop_fraction: cropFraction,
      }),
      // Store enable states
      enable_color: enableColorAug,
      enable_geometric: enableGeometricAug,
      enable_advanced: enableAdvancedAug,
    };
    onSettingsUpdate(settings);
    onOpenChange(false);
  };

  const handleReset = () => {
    setHsvH(0.015);
    setHsvS(0.7);
    setHsvV(0.4);
    setDegrees(0.0);
    setTranslate(0.1);
    setScale(0.5);
    setShear(0.0);
    setPerspective(0.0);
    setFlipud(0.0);
    setFliplr(0.5);
    setMosaic(1.0);
    setMixup(0.0);
    setCopyPaste(0.0);
    setAutoAugment('randaugment');
    setErasing(0.4);
    setCropFraction(1.0);
    setEnableColorAug(true);
    setEnableGeometricAug(true);
    setEnableAdvancedAug(true);
  };

  const handleDisableAll = () => {
    setEnableColorAug(false);
    setEnableGeometricAug(false);
    setEnableAdvancedAug(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto bg-background z-[70]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            YOLO Data Augmentations
          </DialogTitle>
          <DialogDescription>
            Configure data augmentation parameters for training. These augmentations help improve model generalization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Quick Actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleReset}>
              Reset to Defaults
            </Button>
            <Button variant="outline" size="sm" onClick={handleDisableAll}>
              Disable All
            </Button>
          </div>

          <Separator />

          {/* Color Augmentations */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base font-semibold">Color Augmentations</Label>
                <p className="text-xs text-muted-foreground">HSV color space augmentations</p>
              </div>
              <Switch checked={enableColorAug} onCheckedChange={setEnableColorAug} />
            </div>

            {enableColorAug && (
              <div className="grid grid-cols-3 gap-4 pl-4">
                <div className="space-y-2">
                  <Label htmlFor="hsv_h" className="text-sm">
                    Hue Gain
                    <span className="text-xs text-muted-foreground block">Range: 0.0-1.0</span>
                  </Label>
                  <Input
                    id="hsv_h"
                    type="number"
                    step={0.001}
                    min={0}
                    max={1}
                    value={hsvH}
                    onChange={(e) => setHsvH(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hsv_s" className="text-sm">
                    Saturation Gain
                    <span className="text-xs text-muted-foreground block">Range: 0.0-1.0</span>
                  </Label>
                  <Input
                    id="hsv_s"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={hsvS}
                    onChange={(e) => setHsvS(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hsv_v" className="text-sm">
                    Value Gain
                    <span className="text-xs text-muted-foreground block">Range: 0.0-1.0</span>
                  </Label>
                  <Input
                    id="hsv_v"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={hsvV}
                    onChange={(e) => setHsvV(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Geometric Augmentations */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base font-semibold">Geometric Augmentations</Label>
                <p className="text-xs text-muted-foreground">Spatial transformations</p>
              </div>
              <Switch checked={enableGeometricAug} onCheckedChange={setEnableGeometricAug} />
            </div>

            {enableGeometricAug && (
              <div className="grid grid-cols-2 gap-4 pl-4">
                <div className="space-y-2">
                  <Label htmlFor="degrees" className="text-sm">
                    Rotation (degrees)
                    <span className="text-xs text-muted-foreground block">±degrees</span>
                  </Label>
                  <Input
                    id="degrees"
                    type="number"
                    step={1}
                    min={0}
                    max={90}
                    value={degrees}
                    onChange={(e) => setDegrees(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="translate" className="text-sm">
                    Translation
                    <span className="text-xs text-muted-foreground block">Fraction of image</span>
                  </Label>
                  <Input
                    id="translate"
                    type="number"
                    step={0.01}
                    min={0}
                    max={1}
                    value={translate}
                    onChange={(e) => setTranslate(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scale" className="text-sm">
                    Scale
                    <span className="text-xs text-muted-foreground block">Zoom gain</span>
                  </Label>
                  <Input
                    id="scale"
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={scale}
                    onChange={(e) => setScale(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="shear" className="text-sm">
                    Shear (degrees)
                    <span className="text-xs text-muted-foreground block">±degrees</span>
                  </Label>
                  <Input
                    id="shear"
                    type="number"
                    step={1}
                    min={0}
                    max={45}
                    value={shear}
                    onChange={(e) => setShear(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="perspective" className="text-sm">
                    Perspective
                    <span className="text-xs text-muted-foreground block">Distortion</span>
                  </Label>
                  <Input
                    id="perspective"
                    type="number"
                    step={0.001}
                    min={0}
                    max={0.1}
                    value={perspective}
                    onChange={(e) => setPerspective(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="flipud" className="text-sm">
                    Flip Vertical
                    <span className="text-xs text-muted-foreground block">Probability</span>
                  </Label>
                  <Input
                    id="flipud"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={flipud}
                    onChange={(e) => setFlipud(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fliplr" className="text-sm">
                    Flip Horizontal
                    <span className="text-xs text-muted-foreground block">Probability</span>
                  </Label>
                  <Input
                    id="fliplr"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={fliplr}
                    onChange={(e) => setFliplr(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Advanced Augmentations */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base font-semibold">Advanced Augmentations</Label>
                <p className="text-xs text-muted-foreground">Mosaic, MixUp, and other techniques</p>
              </div>
              <Switch checked={enableAdvancedAug} onCheckedChange={setEnableAdvancedAug} />
            </div>

            {enableAdvancedAug && (
              <div className="grid grid-cols-2 gap-4 pl-4">
                <div className="space-y-2">
                  <Label htmlFor="mosaic" className="text-sm">
                    Mosaic
                    <span className="text-xs text-muted-foreground block">Probability (0=off, 1=always)</span>
                  </Label>
                  <Input
                    id="mosaic"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={mosaic}
                    onChange={(e) => setMosaic(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mixup" className="text-sm">
                    MixUp
                    <span className="text-xs text-muted-foreground block">Probability</span>
                  </Label>
                  <Input
                    id="mixup"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={mixup}
                    onChange={(e) => setMixup(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="copy_paste" className="text-sm">
                    Copy-Paste
                    <span className="text-xs text-muted-foreground block">Probability (seg only)</span>
                  </Label>
                  <Input
                    id="copy_paste"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={copyPaste}
                    onChange={(e) => setCopyPaste(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="erasing" className="text-sm">
                    Random Erasing
                    <span className="text-xs text-muted-foreground block">Probability</span>
                  </Label>
                  <Input
                    id="erasing"
                    type="number"
                    step={0.1}
                    min={0}
                    max={1}
                    value={erasing}
                    onChange={(e) => setErasing(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="crop_fraction" className="text-sm">
                    Crop Fraction
                    <span className="text-xs text-muted-foreground block">Image crop fraction</span>
                  </Label>
                  <Input
                    id="crop_fraction"
                    type="number"
                    step={0.1}
                    min={0.1}
                    max={1}
                    value={cropFraction}
                    onChange={(e) => setCropFraction(Number(e.target.value))}
                    className="bg-background"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Apply Augmentations
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
