import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Video, Upload } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

export type VideoServerStage =
  | 'idle'
  | 'uploading'
  | 'receiving'
  | 'extracting'
  | 'saving'
  | 'done'
  | 'error';

export interface VideoUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (file: File, params: {
    interval_seconds: number;
    /** Save every Nth source frame (1 = every frame). */
    frame_step: number;
    max_frames: number;
    sequential_names: boolean;
    resize_width: number;
    resize_height: number;
  }) => void;
  isUploading?: boolean;
  /** Upload progress 0..100. When undefined, no bar is shown. */
  uploadProgress?: number;
  /** Bytes uploaded so far — shown alongside the bar. */
  uploadedBytes?: number;
  /** Total bytes to upload (usually the file size). */
  totalBytes?: number;
  /** High-level stage of the backend after the upload completes. */
  serverStage?: VideoServerStage;
  /** Server-reported progress 0..100 for the extraction phase. */
  serverPercent?: number;
  /** Frames extracted so far (server-reported). */
  framesExtracted?: number;
  /** Total frames the server expects to produce (from FRAME_COUNT / interval). */
  framesExpected?: number;
  /** Target collection name (if the user opened the dialog from a specific tab). */
  targetCollectionName?: string;
}

function formatMB(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const VIDEO_ACCEPT = "video/mp4,video/avi,video/quicktime,video/x-matroska,video/webm,video/x-m4v,video/x-ms-wmv";

export function VideoUploadDialog({
  open,
  onOpenChange,
  onSubmit,
  isUploading = false,
  uploadProgress,
  uploadedBytes,
  totalBytes,
  serverStage = 'idle',
  serverPercent = 0,
  framesExtracted = 0,
  framesExpected = 0,
  targetCollectionName = "",
}: VideoUploadDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [framesPerSecond, setFramesPerSecond] = useState(24);
  const [frameStep, setFrameStep] = useState(1);
  const [maxFramesText, setMaxFramesText] = useState("");
  const [sequentialNames, setSequentialNames] = useState(false);
  const [resizeWidthText, setResizeWidthText] = useState("");
  const [resizeHeightText, setResizeHeightText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
  };

  const handleSelectFile = () => {
    fileInputRef.current?.click();
  };

  const handleSubmit = () => {
    if (!selectedFile) return;
    const safeFps = framesPerSecond > 0 ? framesPerSecond : 24;
    const intervalSeconds = 1 / safeFps;
    const safeFrameStep = frameStep > 0 ? Math.floor(frameStep) : 1;
    const trimmed = maxFramesText.trim();
    const parsedLimit = trimmed === "" ? 0 : Math.max(0, parseInt(trimmed, 10) || 0);
    onSubmit(selectedFile, {
      interval_seconds: intervalSeconds,
      frame_step: safeFrameStep,
      max_frames: parsedLimit,
      sequential_names: sequentialNames,
      resize_width: sequentialNames ? (parseInt(resizeWidthText, 10) || 0) : 0,
      resize_height: sequentialNames ? (parseInt(resizeHeightText, 10) || 0) : 0,
    });
  };

  const handleClose = () => {
    // Don't let the user dismiss the dialog mid-upload; the XHR would keep
    // running in the background and finishing it silently would be confusing.
    if (isUploading) return;
    setSelectedFile(null);
    setFramesPerSecond(24);
    setFrameStep(1);
    setMaxFramesText("");
    setSequentialNames(false);
    setResizeWidthText("");
    setResizeHeightText("");
    onOpenChange(false);
  };

  // Show the bar whenever an upload is in flight or has reported any progress.
  const showProgress = isUploading || (uploadProgress !== undefined && uploadProgress > 0);
  const percent = Math.max(0, Math.min(100, uploadProgress ?? 0));
  const uploadDone = percent >= 100;

  const serverActive =
    serverStage === 'receiving' ||
    serverStage === 'extracting' ||
    serverStage === 'saving' ||
    serverStage === 'done';
  const serverPct = Math.max(0, Math.min(100, serverPercent ?? 0));
  const serverLabel =
    serverStage === 'receiving'
      ? 'Saving upload on server…'
      : serverStage === 'extracting'
      ? 'Extracting frames…'
      : serverStage === 'saving'
      ? 'Writing images to database…'
      : serverStage === 'done'
      ? 'Finished'
      : 'Waiting for server…';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-gray-900 border-gray-700 text-white">
        <DialogHeader>
          <DialogTitle>
            Upload Video
            {targetCollectionName ? (
              <span className="ml-2 text-sm font-normal text-gray-400">
                → {targetCollectionName}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription className="text-gray-400">
            Extract frames from a video and add them as images to your dataset.
            {targetCollectionName
              ? ` Frames will be added to the "${targetCollectionName}" collection.`
              : " Supports MP4, AVI, MOV, MKV, WebM, M4V, WMV."}
          </DialogDescription>
        </DialogHeader>

        <div className="my-4 space-y-4">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden"
            accept={VIDEO_ACCEPT}
          />

          <div
            className="border-2 border-dashed border-gray-700 rounded-lg p-6 text-center hover:border-gray-600 transition-colors cursor-pointer"
            onClick={handleSelectFile}
          >
            <Upload className="mx-auto h-8 w-8 text-gray-400 mb-2" />
            <p className="text-sm font-medium">
              {selectedFile ? selectedFile.name : "Select video file"}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {selectedFile
                ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`
                : "MP4, AVI, MOV, MKV, WebM, M4V, WMV"}
            </p>
          </div>

          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="frame_step" className="text-gray-300">
                Save every Nth frame
              </Label>
              <Input
                id="frame_step"
                type="number"
                min={1}
                step={1}
                value={frameStep}
                onChange={(e) => setFrameStep(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="bg-gray-800 border-gray-600 text-white"
                disabled={isUploading}
              />
              <p className="text-xs text-gray-500">
                1 = save every frame, 10 = every 10th frame, 100 = every 100th frame.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="frames_per_second" className="text-gray-300">
                Frames per second
              </Label>
              <Input
                id="frames_per_second"
                type="number"
                min={0.1}
                step={1}
                value={framesPerSecond}
                onChange={(e) => setFramesPerSecond(Number(e.target.value) || 24)}
                className="bg-gray-800 border-gray-600 text-white"
                disabled={isUploading}
              />
              <p className="text-xs text-gray-500">
                Time-based sampling. Used when "Save every Nth frame" is 1.
                e.g. 24 = 24 fps, 1 = one frame per second, 0.5 ≈ one frame every 2 seconds
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="max_frames" className="text-gray-300">
                Maximum frames (optional)
              </Label>
              <Input
                id="max_frames"
                type="number"
                min={0}
                value={maxFramesText}
                onChange={(e) => setMaxFramesText(e.target.value)}
                className="bg-gray-800 border-gray-600 text-white"
                disabled={isUploading}
              />
              <p className="text-xs text-gray-500">
                Leave empty to use all frames at this frame rate. Set a number to cap total extracted frames.
              </p>
            </div>

            <div className="flex items-start gap-3 pt-1">
              <Checkbox
                id="sequential_names"
                checked={sequentialNames}
                onCheckedChange={(checked) => setSequentialNames(checked === true)}
                disabled={isUploading}
                className="mt-0.5"
              />
              <div>
                <Label htmlFor="sequential_names" className="text-gray-300 cursor-pointer">
                  Sequential frame names
                </Label>
                <p className="text-xs text-gray-500 mt-0.5">
                  Name frames <span className="font-mono text-gray-400">0001.jpg</span>,{" "}
                  <span className="font-mono text-gray-400">0002.jpg</span>… instead of using the
                  video filename. Use this when uploading paired RGB / thermal videos into separate
                  collections so the matching frames share the same name.
                </p>

                {sequentialNames && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-gray-400">
                      Resize frames <span className="text-gray-500">(optional — leave blank to keep native resolution)</span>
                    </p>
                    <p className="text-xs text-gray-500">
                      For annotations to align across layers the two collections must share the same resolution.
                      Enter the target size here, e.g. <span className="font-mono text-gray-400">1280 × 1024</span> for thermal or <span className="font-mono text-gray-400">3840 × 2160</span> for RGB.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        placeholder="Width px"
                        value={resizeWidthText}
                        onChange={(e) => setResizeWidthText(e.target.value)}
                        className="bg-gray-800 border-gray-600 text-white w-32"
                        disabled={isUploading}
                      />
                      <span className="text-gray-500 text-sm">×</span>
                      <Input
                        type="number"
                        min={1}
                        placeholder="Height px"
                        value={resizeHeightText}
                        onChange={(e) => setResizeHeightText(e.target.value)}
                        className="bg-gray-800 border-gray-600 text-white w-32"
                        disabled={isUploading}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {showProgress && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-gray-300">
                  <span>Uploading video…</span>
                  <span className="tabular-nums">
                    {formatMB(uploadedBytes)} / {formatMB(totalBytes ?? selectedFile?.size)}
                    {" · "}
                    {percent.toFixed(0)}%
                  </span>
                </div>
                <Progress value={percent} className="h-2 bg-gray-800" />
              </div>

              {uploadDone && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-gray-300">
                    <span>{serverLabel}</span>
                    <span className="tabular-nums">
                      {framesExpected > 0
                        ? `${framesExtracted} / ${framesExpected} frames · ${serverPct.toFixed(0)}%`
                        : framesExtracted > 0
                        ? `${framesExtracted} frames`
                        : serverActive
                        ? "counting…"
                        : ""}
                    </span>
                  </div>
                  {framesExpected > 0 ? (
                    <Progress value={serverPct} className="h-2 bg-gray-800" />
                  ) : (
                    <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                      <div
                        className={
                          serverActive
                            ? "h-full w-2/5 bg-blue-500 rounded-full animate-[slide_1.4s_ease-in-out_infinite]"
                            : "h-full w-0"
                        }
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleClose}
            variant="outline"
            className="bg-transparent border-gray-700 hover:bg-gray-800 mr-2"
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedFile || isUploading}
            className="bg-blue-600 hover:bg-blue-700 gap-2"
          >
            {isUploading ? (
              <>
                <span className="animate-pulse">Extracting...</span>
              </>
            ) : (
              <>
                <Video className="w-4 h-4" />
                Extract &amp; Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
