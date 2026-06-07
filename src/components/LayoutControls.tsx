
import React from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { 
  LayoutGrid, 
  LayoutPanelLeft, 
  LayoutPanelTop, 
  PanelBottom 
} from 'lucide-react';

export type LayoutType = 'horizontal' | 'vertical' | 'images-only' | 'annotations-only';

interface LayoutControlsProps {
  currentLayout: LayoutType;
  onLayoutChange: (layout: LayoutType) => void;
  compact?: boolean;
}

export function LayoutControls({ currentLayout, onLayoutChange, compact = false }: LayoutControlsProps) {
  const layouts = [
    {
      type: 'horizontal' as LayoutType,
      icon: LayoutPanelLeft,
      label: 'Side by Side',
      description: 'Images and annotations side by side'
    },
    {
      type: 'vertical' as LayoutType,
      icon: LayoutPanelTop,
      label: 'Top/Bottom',
      description: 'Images on top, annotations below'
    },
    {
      type: 'images-only' as LayoutType,
      icon: LayoutGrid,
      label: 'Images Only',
      description: 'Show only images'
    },
    {
      type: 'annotations-only' as LayoutType,
      icon: PanelBottom,
      label: 'Annotations Only',
      description: 'Show only annotations'
    }
  ];

  return (
    <div className={compact ? "flex items-center gap-2" : ""}>
      {!compact && (
        <Card className="p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Layout Options</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Choose how to arrange images and annotations
              </p>
            </div>
            <div className="flex gap-2">
              {layouts.map((layout) => {
                const Icon = layout.icon;
                return (
                  <Button
                    key={layout.type}
                    variant={currentLayout === layout.type ? "default" : "outline"}
                    size="sm"
                    onClick={() => onLayoutChange(layout.type)}
                    className="flex flex-col items-center gap-1 h-auto py-2 px-3"
                    title={layout.description}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-xs">{layout.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Card>
      )}
      
      {compact && (
        <div className="flex gap-2">
          {layouts.map((layout) => {
            const Icon = layout.icon;
            return (
              <Button
                key={layout.type}
                variant={currentLayout === layout.type ? "default" : "outline"}
                size="sm"
                onClick={() => onLayoutChange(layout.type)}
                className="flex items-center gap-1 h-8 px-2"
                title={layout.description}
              >
                <Icon className="h-4 w-4" />
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
