import React, { useState } from 'react';
import { X, Plus, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface TagsInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
  maxTags?: number;
  predefinedTags?: string[];
}

export function TagsInput({
  tags,
  onTagsChange,
  placeholder = "Add tags...",
  className = "",
  maxTags = 10,
  predefinedTags = []
}: TagsInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  // Common predefined tags for annotations
  const defaultPredefinedTags = [
    "training", "validation", "test", "production", "draft", "reviewed",
    "auto-generated", "manual", "verified", "needs-review", "complete",
    "object-detection", "segmentation", "classification", "keypoints",
    "high-quality", "low-quality", "partial", "augmented", "synthetic"
  ];

  const allPredefinedTags = [...new Set([...defaultPredefinedTags, ...predefinedTags])];

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim().toLowerCase();
    if (trimmedTag && !tags.includes(trimmedTag) && tags.length < maxTags) {
      onTagsChange([...tags, trimmedTag]);
    }
    setInputValue("");
    setIsOpen(false);
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(tags.filter(tag => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const filteredPredefinedTags = allPredefinedTags.filter(
    tag => !tags.includes(tag) && 
           tag.toLowerCase().includes(inputValue.toLowerCase())
  );

  return (
    <div className={`flex flex-wrap gap-2 items-center ${className}`}>
      {/* Existing tags */}
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="bg-blue-600/20 text-blue-300 border-blue-600/30 hover:bg-blue-600/30 transition-colors"
        >
          <Tag className="h-3 w-3 mr-1" />
          {tag}
          <Button
            variant="ghost"
            size="sm"
            className="h-auto w-auto p-0 ml-1 hover:bg-transparent"
            onClick={() => removeTag(tag)}
          >
            <X className="h-3 w-3 text-blue-300 hover:text-blue-100" />
          </Button>
        </Badge>
      ))}

      {/* Add new tag */}
      {tags.length < maxTags && (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 border-dashed border-gray-600 text-gray-400 hover:text-gray-300 hover:border-gray-500"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0 bg-gray-900 border-gray-700" align="start">
            <div className="p-3 border-b border-gray-700">
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="h-8 bg-gray-800 border-gray-600 text-white placeholder:text-gray-400"
                autoFocus
              />
            </div>
            
            {/* Predefined tags */}
            {filteredPredefinedTags.length > 0 && (
              <div className="p-3">
                <div className="text-xs text-gray-400 mb-2">Suggested tags:</div>
                <div className="flex flex-wrap gap-1">
                  {filteredPredefinedTags.slice(0, 12).map((tag) => (
                    <Button
                      key={tag}
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-gray-300 hover:text-white hover:bg-gray-800"
                      onClick={() => addTag(tag)}
                    >
                      {tag}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            
            {/* Add custom tag option */}
            {inputValue.trim() && !allPredefinedTags.includes(inputValue.trim().toLowerCase()) && (
              <div className="p-3 border-t border-gray-700">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-blue-300 hover:text-blue-200 hover:bg-blue-900/20"
                  onClick={() => addTag(inputValue)}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add "{inputValue.trim()}"
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}

      {tags.length >= maxTags && (
        <div className="text-xs text-gray-500">
          Max {maxTags} tags
        </div>
      )}
    </div>
  );
}
