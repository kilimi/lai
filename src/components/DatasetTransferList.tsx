import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Database, Image as ImageIcon, Layers, Search, Users, X, Plus } from "lucide-react";
import { Dataset, DatasetGroup } from "@/types";
import { resolveBackendMediaUrl } from "@/config/api";
import { cn } from "@/lib/utils";

interface DatasetTransferListProps {
  allDatasets: Dataset[];
  datasetGroups?: DatasetGroup[];
  /** Group being edited (if any), so its members are not flagged as "in other groups". */
  currentGroupId?: number;
  selected: number[];
  onChange: (next: number[]) => void;
}

interface RowProps {
  dataset: Dataset;
  rightSlot?: React.ReactNode;
  badge?: React.ReactNode;
  onClick: () => void;
  selected?: boolean;
}

function DatasetRow({ dataset, rightSlot, badge, onClick, selected }: RowProps) {
  const thumb = resolveBackendMediaUrl(dataset.thumbnailUrl);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group w-full flex items-center gap-2 px-2 py-1.5 rounded-md border text-left transition-colors",
        selected
          ? "bg-primary/5 border-primary/40"
          : "bg-card border-border/60 hover:border-primary/40 hover:bg-accent/40"
      )}
    >
      {thumb ? (
        <img src={thumb} alt={dataset.name} className="w-7 h-7 rounded object-cover flex-shrink-0" loading="lazy" />
      ) : (
        <div className="w-7 h-7 rounded bg-muted flex items-center justify-center flex-shrink-0">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{dataset.name}</span>
          {badge}
        </div>
        {dataset.description && (
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
            {dataset.description}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
          <span className="flex items-center gap-1">
            <ImageIcon className="h-3 w-3" />
            {dataset.image_count || 0}
          </span>
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {dataset.annotation_count || 0}
          </span>
        </div>
      </div>
      {rightSlot}
    </button>
  );
}

export function DatasetTransferList({
  allDatasets,
  datasetGroups = [],
  currentGroupId,
  selected,
  onChange,
}: DatasetTransferListProps) {
  const [leftSearch, setLeftSearch] = useState("");
  const [rightSearch, setRightSearch] = useState("");

  const datasetToOtherGroupNames = useMemo(() => {
    const map = new Map<number, string[]>();
    datasetGroups.forEach(g => {
      if (g.id === currentGroupId) return;
      (g.datasets || []).forEach(d => {
        if (!map.has(d.id)) map.set(d.id, []);
        map.get(d.id)!.push(g.name);
      });
    });
    return map;
  }, [datasetGroups, currentGroupId]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const matches = (d: Dataset, q: string) => {
    if (!q.trim()) return true;
    const ql = q.toLowerCase();
    return (
      d.name.toLowerCase().includes(ql) ||
      (d.description && d.description.toLowerCase().includes(ql)) ||
      (d.tags && d.tags.some(t => t.toLowerCase().includes(ql)))
    );
  };

  const [otherSearch, setOtherSearch] = useState("");
  const leftAvailable = allDatasets.filter(d => !selectedSet.has(d.id) && !datasetToOtherGroupNames.has(d.id) && matches(d, leftSearch));
  const leftInOtherGroups = allDatasets.filter(d => !selectedSet.has(d.id) && datasetToOtherGroupNames.has(d.id) && matches(d, otherSearch));
  const rightSelected = allDatasets.filter(d => selectedSet.has(d.id) && matches(d, rightSearch));

  const add = (id: number) => {
    if (!selectedSet.has(id)) onChange([...selected, id]);
  };
  const remove = (id: number) => onChange(selected.filter(x => x !== id));

  const addAll = (ids: number[]) => {
    const set = new Set(selected);
    ids.forEach(i => set.add(i));
    onChange(Array.from(set));
  };
  const removeAll = () => onChange([]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* COL 1 — Available */}
      <div className="border rounded-lg flex flex-col min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Available</span>
            <Badge variant="secondary" className="text-[10px]">{leftAvailable.length}</Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={leftAvailable.length === 0}
            onClick={() => addAll(leftAvailable.map(d => d.id))}
          >
            Add all
          </Button>
        </div>
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-3.5 w-3.5" />
            <Input
              placeholder="Search…"
              className="pl-8 h-8 text-sm"
              value={leftSearch}
              onChange={e => setLeftSearch(e.target.value)}
            />
          </div>
        </div>
        <ScrollArea className="h-[340px]">
          <div className="p-2 space-y-1.5">
            {leftAvailable.length > 0 ? (
              leftAvailable.map(d => (
                <DatasetRow
                  key={d.id}
                  dataset={d}
                  onClick={() => add(d.id)}
                  rightSlot={
                    <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                  }
                />
              ))
            ) : (
              <div className="text-center py-10 text-sm text-muted-foreground">
                {leftSearch ? "No matches." : "No available datasets."}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* COL 2 — In other groups */}
      <div className="border border-dashed rounded-lg flex flex-col min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b bg-muted/20 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">In other groups</span>
            <Badge variant="secondary" className="text-[10px]">{leftInOtherGroups.length}</Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={leftInOtherGroups.length === 0}
            onClick={() => addAll(leftInOtherGroups.map(d => d.id))}
          >
            Add all
          </Button>
        </div>
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-3.5 w-3.5" />
            <Input
              placeholder="Search…"
              className="pl-8 h-8 text-sm"
              value={otherSearch}
              onChange={e => setOtherSearch(e.target.value)}
            />
          </div>
        </div>
        <ScrollArea className="h-[340px]">
          <div className="p-2 space-y-1.5">
            {leftInOtherGroups.length > 0 ? (
              leftInOtherGroups.map(d => {
                const otherGroups = datasetToOtherGroupNames.get(d.id) || [];
                return (
                  <DatasetRow
                    key={d.id}
                    dataset={d}
                    onClick={() => add(d.id)}
                    badge={
                      <Badge variant="outline" className="text-[10px] shrink-0 flex items-center gap-1 font-normal">
                        <Users className="h-2.5 w-2.5" />
                        {otherGroups.join(", ")}
                      </Badge>
                    }
                    rightSlot={
                      <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                    }
                  />
                );
              })
            ) : (
              <div className="text-center py-10 text-sm text-muted-foreground">
                {otherSearch ? "No matches." : "None in other groups."}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* COL 3 — Selected */}
      <div className="border-2 border-primary/40 rounded-lg flex flex-col min-h-0 overflow-hidden">
        <div className="px-3 py-2 border-b bg-primary/5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">In this group</span>
            <Badge variant="default" className="text-[10px]">{selected.length}</Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={selected.length === 0}
            onClick={removeAll}
          >
            Remove all
          </Button>
        </div>
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-3.5 w-3.5" />
            <Input
              placeholder="Search selected…"
              className="pl-8 h-8 text-sm"
              value={rightSearch}
              onChange={e => setRightSearch(e.target.value)}
            />
          </div>
        </div>
        <ScrollArea className="h-[340px]">
          <div className="p-2 space-y-1.5">
            {rightSelected.length > 0 ? (
              rightSelected.map(d => {
                const otherGroups = datasetToOtherGroupNames.get(d.id) || [];
                return (
                  <DatasetRow
                    key={d.id}
                    dataset={d}
                    selected
                    onClick={() => remove(d.id)}
                    badge={
                      otherGroups.length > 0 ? (
                        <Badge variant="outline" className="text-[10px] shrink-0 flex items-center gap-1 font-normal">
                          <Users className="h-2.5 w-2.5" />
                          {otherGroups.join(", ")}
                        </Badge>
                      ) : undefined
                    }
                    rightSlot={
                      <X className="h-4 w-4 text-muted-foreground group-hover:text-destructive transition-colors" />
                    }
                  />
                );
              })
            ) : (
              <div className="text-center py-10 text-sm text-muted-foreground">
                {rightSearch ? "No matches." : "Click datasets on the left to add them."}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
