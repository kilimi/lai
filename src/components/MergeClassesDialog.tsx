import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";

export function MergeClassesDialog({ open, onOpenChange, classStats, onMerge }) {
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [mergedName, setMergedName] = useState<string>("");

  const handleMerge = () => {
    if (selectedSources.length && mergedName.trim()) {
      onMerge(selectedSources, mergedName.trim());
      setSelectedSources([]);
      setMergedName("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge Classes</DialogTitle>
        </DialogHeader>
        <div>
          <div className="mb-2 font-medium">Select classes to merge:</div>
          <div className="flex flex-col gap-1 mb-4">
            {classStats.map(stat => (
              <label key={stat.className} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedSources.includes(stat.className)}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelectedSources([...selectedSources, stat.className]);
                    } else {
                      setSelectedSources(selectedSources.filter(c => c !== stat.className));
                    }
                  }}
                />
                <span>{stat.className}</span>
              </label>
            ))}
          </div>
          <div className="mb-2 font-medium">Merged class name:</div>
          <input
            className="w-full border rounded p-1 mb-4 text-black"
            value={mergedName}
            onChange={e => setMergedName(e.target.value)}
            placeholder="Enter new class name"
          />
          <div className="flex justify-end mt-4">
            <Button
              onClick={handleMerge}
              disabled={!selectedSources.length || !mergedName.trim()}
            >
              Merge
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}