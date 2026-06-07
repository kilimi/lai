
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Edit } from "lucide-react";

interface ClassColorOpacityPickerProps {
  annotationId: string;
  className: string;
  color: string;
  opacity: number;
  onColorOpacityChange: (annotationId: string, className: string, color: string, opacity: number) => void;
  onRenameClass?: (className: string) => void;
  onDeleteClass?: (className: string) => void;
}

export function ClassColorOpacityPicker({ 
  annotationId,
  className, 
  color, 
  opacity, 
  onColorOpacityChange,
  onRenameClass,
  onDeleteClass
}: ClassColorOpacityPickerProps) {
  const [tempColor, setTempColor] = useState(color);
  const [tempOpacity, setTempOpacity] = useState(opacity);

  const predefinedColors = [
    "#ea384c", "#F97316", "#1EAEDB", "#8B5CF6", "#2ecc71", 
    "#f39c12", "#9b59b6", "#e74c3c", "#3498db", "#e67e22",
    "#95a5a6", "#34495e", "#1abc9c", "#16a085", "#27ae60"
  ];

  const handleApply = () => {
    onColorOpacityChange(annotationId, className, tempColor, tempOpacity);
  };

  const handleReset = () => {
    setTempColor(color);
    setTempOpacity(opacity);
  };

  return (
    <Card className="p-4 bg-card border-border">
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Label className="text-sm font-medium">
            Configuring: {className}
          </Label>
          {onRenameClass && (
            <button
              className="text-primary hover:text-primary/80 p-1 rounded"
              title="Rename class"
              onClick={() => onRenameClass(className)}
              style={{ lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}
            >
              <Edit className="h-4 w-4" />
            </button>
          )}
          {onDeleteClass && (
            <button
              className="text-destructive hover:text-destructive/80 p-1 rounded"
              title="Delete class"
              onClick={() => onDeleteClass(className)}
              style={{ lineHeight: 0, display: 'inline-flex', alignItems: 'center' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div>
          <Label className="text-sm font-medium mb-2 block">Color</Label>
          <div className="flex gap-2 mb-3">
            <Input
              type="color"
              value={tempColor}
              onChange={(e) => {
                setTempColor(e.target.value);
                onColorOpacityChange(annotationId, className, e.target.value, tempOpacity);
              }}
              className="w-16 h-8 p-1 border"
            />
            <Input
              type="text"
              value={tempColor}
              onChange={(e) => {
                setTempColor(e.target.value);
                onColorOpacityChange(annotationId, className, e.target.value, tempOpacity);
              }}
              placeholder="#000000"
              className="flex-1 h-8"
            />
          </div>
          
          <div className="grid grid-cols-5 gap-2">
            {predefinedColors.map((presetColor) => (
              <button
                key={presetColor}
                className={`w-8 h-8 rounded border-2 ${
                  tempColor === presetColor ? 'border-foreground' : 'border-border'
                }`}
                style={{ backgroundColor: presetColor }}
                onClick={() => {
                  setTempColor(presetColor);
                  onColorOpacityChange(annotationId, className, presetColor, tempOpacity);
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <Label className="text-sm font-medium mb-2 block">
            Opacity: {Math.round(tempOpacity * 100)}%
          </Label>
          <Slider
            value={[tempOpacity]}
            onValueChange={(value) => {
              setTempOpacity(value[0]);
              onColorOpacityChange(annotationId, className, tempColor, value[0]);
            }}
            max={1}
            min={0}
            step={0.05}
            className="w-full"
          />
        </div>

      
        
      </div>
    </Card>
  );
}
