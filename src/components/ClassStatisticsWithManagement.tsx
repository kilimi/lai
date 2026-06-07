import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { ClassManagementMenu } from "./ClassManagementMenu";
import { GlobalMergeClassesDialog } from "./GlobalMergeClassesDialog";
import { Merge, Layers, BarChart3 } from "lucide-react";
import { AnnotationSample } from "@/utils/annotations";

type ClassStat = {
  className: string;
  count: number;
  color: string;
};

interface ClassStatisticsWithManagementProps {
  statistics: ClassStat[];
  annotations: AnnotationSample[];
  selectedClass?: string;
  onClassIconClick?: (className: string) => void;
  onRenameClass: (oldClassName: string, newClassName: string) => void;
  onDeleteClass: (className: string) => void;
  onMergeClasses: (sourceClassName: string, targetClassName: string) => void;
}

export const ClassStatisticsWithManagement: React.FC<ClassStatisticsWithManagementProps> = ({ 
  statistics, 
  annotations,
  selectedClass, 
  onClassIconClick,
  onRenameClass,
  onDeleteClass,
  onMergeClasses
}) => {
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  
  const totalInstances = statistics.reduce(
    (total, stat) => total + (stat.count ?? 0),
    0
  );

  const sortedStats = [...statistics].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const maxCount = sortedStats.length > 0 ? (sortedStats[0].count ?? 0) : 0;
  const availableClasses = sortedStats.map(stat => stat.className);

  if (sortedStats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
        <BarChart3 className="h-8 w-8 mb-2 opacity-40" />
        <span className="text-sm">No class data available</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header with summary and merge button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          <span>{sortedStats.length} {sortedStats.length === 1 ? 'class' : 'classes'}</span>
          <span className="mx-1">·</span>
          <span>{totalInstances.toLocaleString()} total</span>
        </div>
        {availableClasses.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMergeDialog(true)}
            className="h-7 text-xs"
          >
            <Merge className="h-3 w-3 mr-1" />
            Merge
          </Button>
        )}
      </div>

      {/* Distribution bar */}
      <div className="h-2.5 w-full flex rounded-full overflow-hidden bg-muted/50">
        {sortedStats.map((stat) => {
          const pct = totalInstances > 0 ? ((stat.count ?? 0) / totalInstances) * 100 : 0;
          return (
            <div
              key={stat.className}
              className="transition-all duration-300 hover:opacity-80 cursor-pointer first:rounded-l-full last:rounded-r-full"
              style={{
                backgroundColor: stat.color,
                width: `${pct}%`,
                minWidth: pct > 0 ? '3px' : '0',
              }}
              title={`${stat.className}: ${stat.count ?? 0} (${Math.round(pct)}%)`}
              onClick={onClassIconClick ? () => onClassIconClick(stat.className) : undefined}
            />
          );
        })}
      </div>

      {/* Class list with bars and management menu */}
      <div className="space-y-1">
        {sortedStats.map((stat) => {
          const pct = totalInstances > 0 ? ((stat.count ?? 0) / totalInstances) * 100 : 0;
          const barWidth = maxCount > 0 ? ((stat.count ?? 0) / maxCount) * 100 : 0;
          const isSelected = selectedClass === stat.className;

          return (
            <div
              key={stat.className}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-md transition-all duration-150
                ${isSelected
                  ? 'bg-accent ring-1 ring-primary/40 shadow-sm'
                  : 'hover:bg-accent/40'
                }`}
            >
              {/* Color dot - clickable */}
              <button
                type="button"
                className="flex-shrink-0 focus:outline-none"
                onClick={onClassIconClick ? () => onClassIconClick(stat.className) : undefined}
                title={`Select ${stat.className}`}
              >
                <span
                  className={`block w-3 h-3 rounded-sm ring-1 ring-black/10 transition-transform ${isSelected ? 'scale-110' : 'group-hover:scale-105'}`}
                  style={{ backgroundColor: stat.color }}
                />
              </button>

              {/* Name + bar - clickable */}
              <button
                type="button"
                className="flex-1 min-w-0 text-left focus:outline-none"
                onClick={onClassIconClick ? () => onClassIconClick(stat.className) : undefined}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-medium text-foreground truncate pr-2">
                    {stat.className}
                  </span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {(stat.count ?? 0).toLocaleString()}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70 w-8 text-right">
                      {Math.round(pct)}%
                    </span>
                  </div>
                </div>
                <div className="h-1 w-full rounded-full bg-muted/50 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      backgroundColor: stat.color,
                      width: `${barWidth}%`,
                      opacity: isSelected ? 1 : 0.7,
                    }}
                  />
                </div>
              </button>

              {/* Management menu */}
              <ClassManagementMenu
                className={stat.className}
                annotations={annotations}
                availableClasses={availableClasses}
                onRenameClass={onRenameClass}
                onDeleteClass={onDeleteClass}
                onMergeClasses={onMergeClasses}
              />
            </div>
          );
        })}
      </div>

      {/* Global merge classes dialog */}
      <GlobalMergeClassesDialog
        isOpen={showMergeDialog}
        onClose={() => setShowMergeDialog(false)}
        annotations={annotations}
        availableClasses={availableClasses}
        onMerge={onMergeClasses}
      />
    </div>
  );
};
