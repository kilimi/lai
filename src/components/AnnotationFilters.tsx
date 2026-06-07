import React, { useState } from 'react';
import { Search, Filter, X, Tag } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { AnnotationFile } from '@/utils/annotations';

interface AnnotationFiltersProps {
  annotations: AnnotationFile[];
  onFilterChange: (filteredAnnotations: AnnotationFile[]) => void;
  className?: string;
}

export function AnnotationFilters({
  annotations,
  onFilterChange,
  className = ""
}: AnnotationFiltersProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Extract all unique tags and types from annotations
  const allTags = React.useMemo(() => {
    const tagSet = new Set<string>();
    annotations.forEach(annotation => {
      annotation.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [annotations]);

  const allTypes = React.useMemo(() => {
    const typeSet = new Set<string>();
    annotations.forEach(annotation => {
      if (annotation.type) {
        typeSet.add(annotation.type);
      }
      if (annotation.format) {
        typeSet.add(annotation.format);
      }
    });
    return Array.from(typeSet).sort();
  }, [annotations]);

  // Apply filters
  React.useEffect(() => {
    let filtered = [...annotations];

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(annotation => 
        annotation.name.toLowerCase().includes(query) ||
        annotation.tags?.some(tag => tag.toLowerCase().includes(query))
      );
    }

    // Tags filter
    if (selectedTags.length > 0) {
      filtered = filtered.filter(annotation =>
        selectedTags.every(tag => annotation.tags?.includes(tag))
      );
    }

    // Type filter
    if (selectedTypes.length > 0) {
      filtered = filtered.filter(annotation =>
        selectedTypes.includes(annotation.type || '') ||
        selectedTypes.includes(annotation.format || '')
      );
    }

    onFilterChange(filtered);
  }, [annotations, searchQuery, selectedTags, selectedTypes, onFilterChange]);

  const handleTagToggle = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const handleTypeToggle = (type: string) => {
    setSelectedTypes(prev => 
      prev.includes(type) 
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const clearAllFilters = () => {
    setSearchQuery("");
    setSelectedTags([]);
    setSelectedTypes([]);
  };

  const hasActiveFilters = searchQuery.trim() || selectedTags.length > 0 || selectedTypes.length > 0;
  const activeFilterCount = (searchQuery.trim() ? 1 : 0) + selectedTags.length + selectedTypes.length;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Search and filter controls */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search annotations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>

        <Popover open={showFilters} onOpenChange={setShowFilters}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={hasActiveFilters ? "border-primary bg-primary/10" : ""}
            >
              <Filter className="h-4 w-4 mr-2" />
              Filters
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs bg-primary text-primary-foreground">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <div className="p-4 space-y-4">
              {/* Tags Filter */}
              {allTags.length > 0 && (
                <div>
                  <h4 className="font-medium text-sm mb-2 flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    Tags
                  </h4>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {allTags.map((tag) => (
                      <div key={tag} className="flex items-center space-x-2">
                        <Checkbox
                          id={`tag-${tag}`}
                          checked={selectedTags.includes(tag)}
                          onCheckedChange={() => handleTagToggle(tag)}
                        />
                        <Label 
                          htmlFor={`tag-${tag}`} 
                          className="text-sm text-muted-foreground cursor-pointer"
                        >
                          {tag}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Type Filter */}
              {allTypes.length > 0 && (
                <div>
                  <h4 className="font-medium text-sm mb-2">Type/Format</h4>
                  <div className="space-y-2">
                    {allTypes.map((type) => (
                      <div key={type} className="flex items-center space-x-2">
                        <Checkbox
                          id={`type-${type}`}
                          checked={selectedTypes.includes(type)}
                          onCheckedChange={() => handleTypeToggle(type)}
                        />
                        <Label 
                          htmlFor={`type-${type}`} 
                          className="text-sm text-muted-foreground cursor-pointer"
                        >
                          {type}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Clear filters */}
              {hasActiveFilters && (
                <div className="pt-2 border-t border-border">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearAllFilters}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Clear all filters
                  </Button>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAllFilters}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Active filters display */}
      {(selectedTags.length > 0 || selectedTypes.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {selectedTags.map((tag) => (
            <Badge
              key={`tag-${tag}`}
              variant="secondary"
              className="bg-primary/20 text-primary border-primary/30"
            >
              <Tag className="h-3 w-3 mr-1" />
              {tag}
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-auto p-0 ml-1 hover:bg-transparent"
                onClick={() => handleTagToggle(tag)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          {selectedTypes.map((type) => (
            <Badge
              key={`type-${type}`}
              variant="secondary"
              className="bg-accent text-accent-foreground border-accent"
            >
              {type}
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-auto p-0 ml-1 hover:bg-transparent"
                onClick={() => handleTypeToggle(type)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
