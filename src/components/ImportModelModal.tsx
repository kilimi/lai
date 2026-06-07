import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Upload, FileCode2, ListTree, X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { getApiBaseUrl } from '@/config/api';

interface ImportModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onImported?: () => void;
}

type ModelFormat = 'onnx' | 'pt';

interface ParsedClasses {
  names: string[];
  raw: unknown;
}

/**
 * Parse a classes.json file. Accepts a few common shapes:
 *  - { "class_names": ["a","b"] }
 *  - { "names": ["a","b"] } or { "names": {"0":"a","1":"b"} }
 *  - ["a","b"]
 */
function parseClassesJson(text: string): ParsedClasses {
  const data = JSON.parse(text);
  let names: string[] = [];
  if (Array.isArray(data)) {
    names = data.map(String);
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.class_names)) names = (obj.class_names as unknown[]).map(String);
    else if (Array.isArray(obj.names)) names = (obj.names as unknown[]).map(String);
    else if (obj.names && typeof obj.names === 'object') {
      names = Object.entries(obj.names as Record<string, unknown>)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, v]) => String(v));
    } else if (Array.isArray(obj.classes)) names = (obj.classes as unknown[]).map(String);
  }
  return { names, raw: data };
}

function detectFormat(name: string): ModelFormat | null {
  if (/\.onnx$/i.test(name)) return 'onnx';
  if (/\.pt$/i.test(name)) return 'pt';
  return null;
}

export function ImportModelModal({ open, onOpenChange, projectId, onImported }: ImportModelModalProps) {
  const { toast } = useToast();
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const classesInputRef = useRef<HTMLInputElement | null>(null);

  const [modelName, setModelName] = useState('');
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [modelFormat, setModelFormat] = useState<ModelFormat | null>(null);
  const [classesFile, setClassesFile] = useState<File | null>(null);
  const [classesParseError, setClassesParseError] = useState<string | null>(null);
  const [parsedClasses, setParsedClasses] = useState<ParsedClasses | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setModelName('');
      setModelFile(null);
      setModelFormat(null);
      setClassesFile(null);
      setClassesParseError(null);
      setParsedClasses(null);
      setSubmitting(false);
    }
  }, [open]);

  const pickModel = (file: File | null) => {
    if (!file) {
      setModelFile(null);
      setModelFormat(null);
      return;
    }
    const fmt = detectFormat(file.name);
    if (!fmt) {
      toast({
        title: 'Unsupported file',
        description: 'Please select a .onnx or .pt model file.',
        variant: 'destructive',
      });
      return;
    }
    setModelFile(file);
    setModelFormat(fmt);
    if (!modelName) {
      setModelName(file.name.replace(/\.(onnx|pt)$/i, ''));
    }
  };

  const pickClasses = async (file: File | null) => {
    setClassesParseError(null);
    setParsedClasses(null);
    if (!file) {
      setClassesFile(null);
      return;
    }
    if (!/\.json$/i.test(file.name)) {
      setClassesParseError('Classes file must be a .json file');
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseClassesJson(text);
      if (parsed.names.length === 0) {
        setClassesParseError(
          'Could not find class names. Expected { "class_names": [...] }, { "names": [...] }, or a JSON array.',
        );
        return;
      }
      setClassesFile(file);
      setParsedClasses(parsed);
    } catch (err) {
      setClassesParseError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  const formatBytes = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  // classes.json is REQUIRED for .onnx (ONNX doesn't embed class names),
  // OPTIONAL for .pt (Ultralytics weights embed `model.names`).
  const classesRequired = modelFormat === 'onnx';

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!modelFile || !modelFormat) return false;
    if (!modelName.trim()) return false;
    if (classesRequired && (!classesFile || !parsedClasses || parsedClasses.names.length === 0)) return false;
    if (classesFile && !parsedClasses) return false; // file picked but failed to parse
    return true;
  }, [submitting, modelFile, modelFormat, modelName, classesRequired, classesFile, parsedClasses]);

  const handleSubmit = async () => {
    if (!canSubmit || !modelFile || !modelFormat) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('name', modelName.trim());
      fd.append('project_id', projectId);
      fd.append('model_format', modelFormat);
      fd.append('model_file', modelFile, modelFile.name);
      // Back-compat: also expose under format-specific field name
      fd.append(modelFormat, modelFile, modelFile.name);
      if (classesFile) {
        fd.append('classes', classesFile, classesFile.name);
      }

      const res = await fetch(`${getApiBaseUrl()}/training/import`, {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Import failed (${res.status})`);
      }

      toast({
        title: 'Model imported',
        description: `"${modelName.trim()}" was added to this project.`,
      });
      onImported?.();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Could not import model',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            Import Model
          </DialogTitle>
          <DialogDescription>
            Import an existing <span className="font-medium">ONNX</span> model or an Ultralytics{' '}
            <span className="font-medium">YOLO .pt</span> checkpoint. The model becomes available for inference in this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Model name */}
          <div className="space-y-2">
            <Label htmlFor="import-model-name">Model name</Label>
            <Input
              id="import-model-name"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder="e.g. yolo11n-crops-v1"
            />
          </div>

          {/* Model file (.onnx or .pt) */}
          <div className="space-y-2">
            <Label>Model file (.onnx or .pt)</Label>
            <input
              ref={modelInputRef}
              type="file"
              accept=".onnx,.pt"
              className="hidden"
              onChange={(e) => pickModel(e.target.files?.[0] ?? null)}
            />
            {modelFile && modelFormat ? (
              <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/30">
                <FileCode2 className="w-5 h-5 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate flex items-center gap-2">
                    {modelFile.name}
                    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                      {modelFormat === 'pt' ? 'YOLO .pt' : 'ONNX'}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{formatBytes(modelFile.size)}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setModelFile(null);
                    setModelFormat(null);
                    if (modelInputRef.current) modelInputRef.current.value = '';
                  }}
                  aria-label="Remove model file"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start"
                onClick={() => modelInputRef.current?.click()}
              >
                <Upload className="w-4 h-4 mr-2" />
                Choose .onnx or .pt file
              </Button>
            )}
          </div>

          {/* classes.json */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                Classes (classes.json){' '}
                {classesRequired ? (
                  <span className="text-destructive">*</span>
                ) : (
                  <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                )}
              </Label>
            </div>
            <input
              ref={classesInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => pickClasses(e.target.files?.[0] ?? null)}
            />
            {classesFile && parsedClasses ? (
              <div className="p-3 border rounded-md bg-muted/30 space-y-2">
                <div className="flex items-center gap-3">
                  <ListTree className="w-5 h-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{classesFile.name}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-green-600" />
                      {parsedClasses.names.length} classes detected
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setClassesFile(null);
                      setParsedClasses(null);
                      if (classesInputRef.current) classesInputRef.current.value = '';
                    }}
                    aria-label="Remove classes file"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-auto">
                  {parsedClasses.names.slice(0, 60).map((name, i) => (
                    <Badge key={`${name}-${i}`} variant="secondary" className="text-xs font-normal">
                      {i}: {name}
                    </Badge>
                  ))}
                  {parsedClasses.names.length > 60 && (
                    <Badge variant="outline" className="text-xs">
                      +{parsedClasses.names.length - 60} more
                    </Badge>
                  )}
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start"
                onClick={() => classesInputRef.current?.click()}
              >
                <Upload className="w-4 h-4 mr-2" />
                Choose classes.json
              </Button>
            )}
            {classesParseError && (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{classesParseError}</span>
              </div>
            )}
            {modelFormat === 'pt' && !classesFile && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Ultralytics <code className="font-mono">.pt</code> checkpoints embed class names — providing
                  classes.json is optional and only needed to override them.
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Accepted shapes: <code className="font-mono">{`{"class_names":[...]}`}</code>,{' '}
              <code className="font-mono">{`{"names":[...]}`}</code>, or a JSON array.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Importing…' : 'Import model'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ImportModelModal;
