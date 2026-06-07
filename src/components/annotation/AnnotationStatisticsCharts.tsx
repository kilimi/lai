/**
 * Statistics charts for the segmentation Annotation Panel (recharts lazy-loaded).
 */
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface AnnotationClassStat {
  id: string;
  name: string;
  color: string;
  count: number;
  percentage: number;
  avgArea?: number;
  hasUnsaved?: boolean;
  unsavedDelta?: number;
}

export interface AnnotationStatisticsChartsProps {
  classes: AnnotationClassStat[];
  total: number;
  hasUnsavedChanges?: boolean;
  unsavedAnnotationCount?: number;
}

const tooltipStyle = {
  backgroundColor: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "6px",
  color: "hsl(var(--popover-foreground))",
  fontSize: "12px",
};

function formatArea(area: number): string {
  if (area >= 1_000_000) return `${(area / 1_000_000).toFixed(2)} Mpx²`;
  if (area >= 1_000) return `${(area / 1_000).toFixed(1)} kpx²`;
  return `${Math.round(area)} px²`;
}

export default function AnnotationStatisticsCharts({
  classes,
  total,
  hasUnsavedChanges,
  unsavedAnnotationCount,
}: AnnotationStatisticsChartsProps) {
  const pieData = classes.filter((c) => c.count > 0);
  const maxCount = classes.reduce((m, c) => Math.max(m, c.count), 0);

  if (classes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No classes defined yet
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {classes.length} {classes.length === 1 ? "class" : "classes"}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-foreground">{total.toLocaleString()}</span>
          <span className="text-xs text-muted-foreground">annotations</span>
        </div>
      </div>

      {hasUnsavedChanges && (unsavedAnnotationCount ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-500 bg-amber-500/10 px-2 py-1 rounded">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Includes {unsavedAnnotationCount} unsaved annotation
          {unsavedAnnotationCount !== 1 ? "s" : ""} from current image
        </div>
      )}

      {/* Pie chart — all classes */}
      <div className="rounded-lg border border-border bg-muted/20 p-2">
        <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
          Class distribution
        </h3>
        {pieData.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-10">
            No annotations yet
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={48}
                outerRadius={82}
                paddingAngle={pieData.length > 1 ? 2 : 0}
                stroke="hsl(var(--background))"
                strokeWidth={2}
              >
                {pieData.map((entry) => (
                  <Cell key={entry.id} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: number, _name, props) => {
                  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0";
                  return [`${value.toLocaleString()} (${pct}%)`, props.payload?.name ?? "Count"];
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
        {pieData.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1">
            {pieData.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0 ring-1 ring-black/10"
                  style={{ backgroundColor: c.color }}
                />
                <span className="truncate max-w-[120px]" title={c.name}>
                  {c.name}
                </span>
                <span className="tabular-nums">{Math.round(c.percentage)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bar chart per class */}
      <div className="space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground px-1">
          Count by class
        </h3>
        {classes.map((c) => {
          const barData = [{ name: c.name, count: c.count, fill: c.color }];
          const domainMax = Math.max(maxCount, 1);

          return (
            <div
              key={c.id}
              className="rounded-lg border border-border bg-muted/10 p-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2 px-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-3 h-3 rounded-sm shrink-0 ring-1 ring-black/10"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="text-xs font-medium truncate" title={c.name}>
                    {c.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  <span>{c.count.toLocaleString()}</span>
                  {c.hasUnsaved && c.unsavedDelta ? (
                    <span className="text-amber-500" title={`+${c.unsavedDelta} unsaved`}>
                      *
                    </span>
                  ) : null}
                  <span className="text-muted-foreground/70 w-8 text-right">
                    {Math.round(c.percentage)}%
                  </span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={44}>
                <BarChart
                  data={barData}
                  layout="vertical"
                  margin={{ top: 0, right: 4, left: 4, bottom: 0 }}
                >
                  <XAxis type="number" domain={[0, domainMax]} hide />
                  <YAxis type="category" dataKey="name" hide width={0} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(value: number) => [value.toLocaleString(), "Annotations"]}
                    cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
                    <Cell fill={c.color} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {c.avgArea != null && c.avgArea > 0 && (
                <p className="text-[10px] text-muted-foreground px-0.5">
                  Avg area: {formatArea(c.avgArea)}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
