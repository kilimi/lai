import React from "react";
import { BarChart3, Layers } from "lucide-react";

type ClassStat = {
  className: string;
  count: number;
  color: string;
};

interface ClassStatisticsProps {
  statistics: ClassStat[];
  selectedClass?: string;
  onClassIconClick?: (className: string) => void;
}

export const ClassStatistics: React.FC<ClassStatisticsProps> = ({ statistics, selectedClass, onClassIconClick }) => {
  const totalInstances = statistics.reduce(
    (total, stat) => total + (stat.count ?? 0),
    0
  );

  const sortedStats = [...statistics].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const maxCount = sortedStats.length > 0 ? (sortedStats[0].count ?? 0) : 0;

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
      {/* Header summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          <span>{sortedStats.length} {sortedStats.length === 1 ? 'class' : 'classes'}</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {totalInstances.toLocaleString()} total
        </span>
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

      {/* Class list with horizontal bars */}
      <div className="space-y-1">
        {sortedStats.map((stat) => {
          const pct = totalInstances > 0 ? ((stat.count ?? 0) / totalInstances) * 100 : 0;
          const barWidth = maxCount > 0 ? ((stat.count ?? 0) / maxCount) * 100 : 0;
          const isSelected = selectedClass === stat.className;

          return (
            <button
              key={stat.className}
              type="button"
              className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-all duration-150
                ${isSelected
                  ? 'bg-accent ring-1 ring-primary/40 shadow-sm'
                  : 'hover:bg-accent/40'
                }`}
              onClick={onClassIconClick ? () => onClassIconClick(stat.className) : undefined}
              data-testid={`class-color-${stat.className.replace(/\s+/g, '-')}`}
            >
              {/* Color dot */}
              <span
                className={`w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10 transition-transform ${isSelected ? 'scale-110' : 'group-hover:scale-105'}`}
                style={{ backgroundColor: stat.color }}
              />

              {/* Name + bar */}
              <div className="flex-1 min-w-0">
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
                {/* Mini bar showing relative count */}
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
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
