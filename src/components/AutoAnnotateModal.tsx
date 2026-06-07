import * as React from "react";
import { cn } from "@/lib/utils";
import { Bot, Crosshair, Layers, ChevronDown } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getApiBaseUrl } from "@/config/api";
import type { ImageCollection } from "@/types";

interface AutoAnnotateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: number;
  datasetName: string;
  imageCollections?: ImageCollection[];
}

/** Default collection for Auto-Annotate: backend default (e.g. primary RGB), else first collection. */
function defaultAutoAnnotateCollectionId(collections: ImageCollection[]): string {
  if (collections.length === 0) return "";
  const preferred = collections.find((c) => c.is_default === true);
  return String(preferred?.id ?? collections[0].id);
}

type Family = "yolo" | "depth_anything";

/** Fixed Auto-Annotate YOLO model (ONNX, medium). */
const YOLO_MODEL = "yolo11m";

type YoloTask = "detect" | "segment" | "classify";

const YOLO_ONNX_BY_TASK: Record<YoloTask, string> = {
  detect: "yolo11m.onnx",
  segment: "yolo11m-seg.onnx",
  classify: "yolo11m-cls.onnx",
};

const YOLO_TASKS: { value: YoloTask; label: string; desc: string }[] = [
  { value: "detect", label: "Detection", desc: "Bounding boxes (COCO)" },
  { value: "segment", label: "Segmentation", desc: "Instance masks (COCO)" },
  { value: "classify", label: "Classification", desc: "Image-level labels (ImageNet)" },
];

const DEPTH_SIZES = [
  { value: "vits", label: "Small (ViT-S)" },
  { value: "vitb", label: "Base (ViT-B)" },
  { value: "vitl", label: "Large (ViT-L)" },
];

const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
  "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
  "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

export function AutoAnnotateModal({
  open,
  onOpenChange,
  datasetId,
  datasetName,
  imageCollections = [],
}: AutoAnnotateModalProps) {
  const { toast } = useToast();
  const [selectedFamily, setSelectedFamily] = React.useState<Family | null>(null);
  const [selectedTask, setSelectedTask] = React.useState<YoloTask>("detect");
  const [annotationFileName, setAnnotationFileName] = React.useState("");
  const [saveAsNew, setSaveAsNew] = React.useState(false);
  const [newDatasetName, setNewDatasetName] = React.useState("");
  const [showClasses, setShowClasses] = React.useState(false);
  const [confThreshold, setConfThreshold] = React.useState(0.25);
  const [depthEnvironment, setDepthEnvironment] = React.useState<"indoor" | "outdoor">("outdoor");
  const [selectedSize, setSelectedSize] = React.useState("vitb");
  const [selectedCollectionId, setSelectedCollectionId] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setSelectedCollectionId(defaultAutoAnnotateCollectionId(imageCollections));
    setSelectedFamily(null);
    setSelectedTask("detect");
    setAnnotationFileName("");
    setConfThreshold(0.25);
    setShowClasses(false);
    setSaveAsNew(false);
    setNewDatasetName("");
    setDepthEnvironment("outdoor");
    setSelectedSize("vitb");
  }, [open, imageCollections]);

  const selectedModel = selectedFamily === "yolo"
    ? YOLO_MODEL
    : selectedFamily === "depth_anything"
    ? `depth_anything_v2_${selectedSize}_${depthEnvironment}`
    : "";

  const handleSubmit = async () => {
    try {
      const body: Record<string, unknown> = {
        model_name: selectedModel,
        dataset_id: datasetId,
      };

      const collIdStr =
        selectedCollectionId || defaultAutoAnnotateCollectionId(imageCollections);
      const cid = parseInt(collIdStr, 10);
      if (!Number.isNaN(cid)) {
        body.collection_id = cid;
      }

      if (selectedFamily === "yolo") {
        body.annotation_file_name = annotationFileName || `Auto_${selectedModel}_${new Date().toISOString().split("T")[0]}`;
        body.conf_threshold = confThreshold;
        body.task_type = selectedTask;
      } else if (selectedFamily === "depth_anything") {
        body.save_as = saveAsNew ? "dataset" : "collection";
        body.environment = depthEnvironment;
        body.model_size = selectedSize;
        if (saveAsNew) {
          body.new_dataset_name = newDatasetName || `${datasetName} - Depth`;
        }
      }

      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/preannotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      const baseDesc = `Running ${selectedModel} on ${datasetName}. Check tasks for progress.`;
      const downloadNote =
        result.weights_download_expected && result.weights_download_notice
          ? ` ${result.weights_download_notice}`
          : "";

      toast({
        title: "Auto-annotation started",
        description: `${baseDesc}${downloadNote}`,
      });
    } catch (error) {
      console.error("Auto-annotation error:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to start auto-annotation",
        variant: "destructive",
      });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Bot className="h-5 w-5 text-primary" />
            Auto-Annotate with AI
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Automatically generate annotations for <span className="font-medium text-foreground">{datasetName}</span> using a pre-trained model.
          </p>
        </DialogHeader>
        <div className="flex flex-col gap-4 mt-2">
          {imageCollections.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="auto-annotate-collection" className="text-sm font-medium">
                Image collection
              </Label>
              <Select
                value={selectedCollectionId || defaultAutoAnnotateCollectionId(imageCollections)}
                onValueChange={setSelectedCollectionId}
              >
                <SelectTrigger id="auto-annotate-collection" className="text-sm">
                  <SelectValue placeholder="Select collection" />
                </SelectTrigger>
                <SelectContent>
                  {imageCollections.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)} className="text-sm">
                      {c.name}
                      {c.is_default ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Run Auto-Annotate only on images in this collection.
              </p>
            </div>
          )}

          <span className="block font-medium text-sm">Choose a model family</span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { key: "yolo" as Family, icon: Crosshair, label: "YOLO11 Medium", desc: "Detection, segmentation & classification (ONNX)" },
              { key: "depth_anything" as Family, icon: Layers, label: "Depth Anything V2", desc: "Monocular depth estimation" },
            ]).map(({ key, icon: Icon, label, desc }) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedFamily(key);
                  if (key === "yolo") {
                    setSelectedTask("detect");
                  } else {
                    setSelectedSize("vitb");
                    setDepthEnvironment("outdoor");
                  }
                  setSaveAsNew(false);
                  setNewDatasetName("");
                }}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left transition-all",
                  selectedFamily === key
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border hover:border-muted-foreground/30 hover:bg-muted/40"
                )}
              >
                <div className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                  selectedFamily === key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </div>
              </button>
            ))}
          </div>

          {selectedFamily === "yolo" && (
            <>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm space-y-1">
                <div>
                  Model: <span className="font-medium">YOLO11 Medium</span> (pretrained, ONNX)
                </div>
                <div className="text-xs text-muted-foreground">
                  Weights: <span className="font-mono">{YOLO_ONNX_BY_TASK[selectedTask]}</span>
                </div>
              </div>

              <div className="space-y-2">
                <span className="block font-medium text-sm">Task</span>
                <div className="flex gap-1.5 flex-wrap">
                  {YOLO_TASKS.map(({ value, label, desc }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSelectedTask(value)}
                      className={cn(
                        "flex flex-col rounded-md border px-3 py-1.5 text-sm transition-all",
                        selectedTask === value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-muted/40"
                      )}
                    >
                      <span className="font-medium">{label}</span>
                      <span className={cn("text-xs", selectedTask === value ? "text-primary-foreground/70" : "text-muted-foreground")}>{desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedTask !== "classify" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Confidence Threshold</Label>
                    <span className="text-sm font-mono text-muted-foreground">{confThreshold.toFixed(2)}</span>
                  </div>
                  <Slider
                    min={0.05}
                    max={0.95}
                    step={0.05}
                    value={[confThreshold]}
                    onValueChange={([v]) => setConfThreshold(v)}
                  />
                </div>
              )}

              {selectedTask === "detect" || selectedTask === "segment" ? (
                <div className="rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setShowClasses(!showClasses)}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/40 transition-colors rounded-lg"
                  >
                    <span className="text-muted-foreground">
                      Pretrained on <span className="font-medium text-foreground">COCO</span> — {COCO_CLASSES.length} classes
                    </span>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showClasses && "rotate-180")} />
                  </button>
                  {showClasses && (
                    <div className="px-3 pb-3 flex flex-wrap gap-1">
                      {COCO_CLASSES.map((cls) => (
                        <span
                          key={cls}
                          className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {cls}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Classification uses ImageNet-1k labels (1000 classes). Class names are loaded from the exported ONNX sidecar.
                </p>
              )}

              <div className="space-y-2">
                <Label htmlFor="annotation-file-name" className="text-sm font-medium">
                  Annotation File Name
                </Label>
                <Input
                  id="annotation-file-name"
                  placeholder={`Auto_${selectedModel}_${new Date().toISOString().split("T")[0]}`}
                  value={annotationFileName}
                  onChange={(e) => setAnnotationFileName(e.target.value)}
                  className="text-sm"
                />
              </div>
            </>
          )}

          {selectedFamily === "depth_anything" && (
            <>
              <div className="space-y-2">
                <span className="block font-medium text-sm">Environment</span>
                <div className="flex gap-1.5">
                  {[{ value: "outdoor" as const, label: "Outdoor" }, { value: "indoor" as const, label: "Indoor" }].map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDepthEnvironment(value)}
                      className={cn(
                        "rounded-md border px-4 py-1.5 text-sm font-medium transition-all",
                        depthEnvironment === value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-muted/40"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="block font-medium text-sm">Model size</span>
                <div className="flex gap-1.5">
                  {DEPTH_SIZES.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSelectedSize(value)}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-sm font-medium transition-all",
                        selectedSize === value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-muted/40"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm text-muted-foreground">
                  Output will be saved as a <span className="font-medium text-foreground">New Image Collection</span>.
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="save-as-dataset"
                    checked={saveAsNew}
                    onCheckedChange={(checked) => setSaveAsNew(checked === true)}
                  />
                  <Label htmlFor="save-as-dataset" className="text-sm font-medium cursor-pointer">
                    Save as New Dataset instead
                  </Label>
                </div>

                {saveAsNew && (
                  <div className="space-y-1.5 pl-6">
                    <Label htmlFor="new-dataset-name" className="text-xs text-muted-foreground">
                      Dataset name
                    </Label>
                    <Input
                      id="new-dataset-name"
                      placeholder={`${datasetName} - Depth`}
                      value={newDatasetName}
                      onChange={(e) => setNewDatasetName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!selectedFamily} onClick={handleSubmit}>
              <Bot className="h-4 w-4 mr-2" />
              Start Annotation
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
