
import React from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Save, Undo, Redo, Square } from 'lucide-react';

interface AnnotationToolbarProps {
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export const AnnotationToolbar = ({ 
  onSave, 
  onUndo, 
  onRedo, 
  canUndo, 
  canRedo 
}: AnnotationToolbarProps) => {
  return (
    <div className="flex items-center gap-2 p-2 bg-gray-800 rounded-lg">
      <Button
        variant="outline"
        size="sm"
        onClick={onSave}
        className="border-gray-600 hover:bg-gray-700"
      >
        <Save className="h-4 w-4 mr-2" />
        Save
      </Button>
      
      <Separator orientation="vertical" className="h-6 bg-gray-600" />
      
      <Button
        variant="outline"
        size="sm"
        onClick={onUndo}
        disabled={!canUndo}
        className="border-gray-600 hover:bg-gray-700 disabled:opacity-50"
      >
        <Undo className="h-4 w-4" />
      </Button>
      
      <Button
        variant="outline"
        size="sm"
        onClick={onRedo}
        disabled={!canRedo}
        className="border-gray-600 hover:bg-gray-700 disabled:opacity-50"
      >
        <Redo className="h-4 w-4" />
      </Button>
      
      <Separator orientation="vertical" className="h-6 bg-gray-600" />
      
      <Button
        variant="outline"
        size="sm"
        className="border-gray-600 hover:bg-gray-700"
      >
        <Square className="h-4 w-4 mr-2" />
        Rectangle
      </Button>
    </div>
  );
};
