
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Palette } from "lucide-react";

interface ClassColorPickerProps {
  className: string;
  color: string;
  count: number;
  onColorChange: (className: string, color: string) => void;
}

export function ClassColorPicker({ className, color, count, onColorChange }: ClassColorPickerProps) {
  const [tempColor, setTempColor] = useState(color);
  const [isOpen, setIsOpen] = useState(false);

  const predefinedColors = [
    "#ea384c", "#F97316", "#1EAEDB", "#8B5CF6", "#2ecc71", 
    "#f39c12", "#9b59b6", "#e74c3c", "#3498db", "#e67e22",
    "#95a5a6", "#34495e", "#1abc9c", "#16a085", "#27ae60"
  ];

  const handleApplyColor = () => {
    onColorChange(className, tempColor);
    setIsOpen(false);
  };

  return (
    <div className="flex items-center justify-between p-2 bg-gray-900 rounded-lg">
      <div className="flex items-center gap-3">
        <Badge 
          style={{ backgroundColor: color }}
          className="text-white border-0"
        >
          {className}
        </Badge>
        <span className="text-sm text-gray-400">{count} annotations</span>
      </div>
      
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
          >
            <Palette className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-4" side="left">
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Custom Color</label>
              <div className="flex gap-2">
                <Input
                  type="color"
                  value={tempColor}
                  onChange={(e) => setTempColor(e.target.value)}
                  className="w-16 h-8 p-1 border"
                />
                <Input
                  type="text"
                  value={tempColor}
                  onChange={(e) => setTempColor(e.target.value)}
                  placeholder="#000000"
                  className="flex-1 h-8"
                />
              </div>
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Preset Colors</label>
              <div className="grid grid-cols-5 gap-2">
                {predefinedColors.map((presetColor) => (
                  <button
                    key={presetColor}
                    className={`w-8 h-8 rounded border-2 ${
                      tempColor === presetColor ? 'border-white' : 'border-gray-600'
                    }`}
                    style={{ backgroundColor: presetColor }}
                    onClick={() => setTempColor(presetColor)}
                  />
                ))}
              </div>
            </div>
            
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsOpen(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleApplyColor}
                className="flex-1"
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
