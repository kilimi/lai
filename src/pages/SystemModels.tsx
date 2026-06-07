/**
 * System Models page — inventory of foundation weights mounted on the host
 * volume. Tells customers what's installed and how to fetch more.
 */
import { useEffect, useMemo, useState } from "react";
import { LAI_TUTORIALS_URL } from "@/constants/externalLinks";
import { Check, Minus, Copy, RefreshCw, HardDrive, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { getApiBaseUrl } from "@/config/api";

interface YoloModel {
  file: string;
  name: string;
  arch: string;
  size: string;
  task: string;
  present: boolean;
  size_mb: number;
}

interface DepthModel {
  file: string;
  variant: string;
  environment: string;
  present: boolean;
  size_mb: number;
}

interface ModelsResponse {
  yolo: YoloModel[];
  depth: DepthModel[];
  summary: {
    yolo_present: number;
    yolo_total: number;
    depth_present: number;
    depth_total: number;
  };
  paths: { yolo_dir: string; depth_dir: string };
  commands: Record<string, string>;
  notice: string;
}

function PresenceBadge({ present }: { present: boolean }) {
  if (present) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        <Check className="h-3 w-3" /> installed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Minus className="h-3 w-3" /> missing
    </Badge>
  );
}

function CopyableCommand({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
      <code className="flex-1 break-all">{value}</code>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default function SystemModels() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/system/models`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const yolo = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return q ? data.yolo.filter((m) => m.file.toLowerCase().includes(q)) : data.yolo;
  }, [data, filter]);

  const depth = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    return q ? data.depth.filter((m) => m.file.toLowerCase().includes(q)) : data.depth;
  }, [data, filter]);

  return (
    <div className="container mx-auto max-w-5xl py-8 space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2">
          <Badge variant="secondary" className="gap-1.5">
            <HardDrive className="h-3.5 w-3.5" /> System
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight">Foundation Models</h1>
          <p className="text-muted-foreground max-w-2xl">
            Models live on a host volume mounted into the backend. Pre-download
            what you need for offline use, or let LAI fetch them on demand the
            first time a job runs.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a href={LAI_TUTORIALS_URL} target="_blank" rel="noopener noreferrer">
              Tutorials
            </a>
          </Button>
        </div>
      </header>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            Failed to load model inventory: {error}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  YOLO &amp; RT-DETR weights
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {data.summary.yolo_present}{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    / {data.summary.yolo_total} installed
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  {data.paths.yolo_dir}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Depth-Anything weights
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">
                  {data.summary.depth_present}{" "}
                  <span className="text-base font-normal text-muted-foreground">
                    / {data.summary.depth_total} installed
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 font-mono">
                  {data.paths.depth_dir}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-primary" /> Get more models
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{data.notice}</p>
              <div className="space-y-2">
                <div>
                  <div className="text-xs font-medium mb-1">Everything (largest, ~10 GB)</div>
                  <CopyableCommand value={data.commands.all} />
                </div>
                <div>
                  <div className="text-xs font-medium mb-1">Minimal set (nano + small heads)</div>
                  <CopyableCommand value={data.commands.minimal} />
                </div>
                <div>
                  <div className="text-xs font-medium mb-1">A specific YOLO weight</div>
                  <CopyableCommand value={data.commands.single_yolo} />
                </div>
                <div>
                  <div className="text-xs font-medium mb-1">A specific Depth-Anything weight</div>
                  <CopyableCommand value={data.commands.single_depth} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Input
            placeholder="Filter models by filename…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-sm"
          />

          <Card>
            <CardHeader>
              <CardTitle>YOLO &amp; RT-DETR foundation matrix</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Arch</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead className="text-right">Size on disk</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {yolo.map((m) => (
                    <TableRow key={m.file}>
                      <TableCell className="font-mono text-xs">{m.file}</TableCell>
                      <TableCell>{m.arch}</TableCell>
                      <TableCell className="uppercase">{m.size || "–"}</TableCell>
                      <TableCell>{m.task}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {m.size_mb ? `${m.size_mb} MB` : "–"}
                      </TableCell>
                      <TableCell className="text-right">
                        <PresenceBadge present={m.present} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Depth-Anything ONNX</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead className="text-right">Size on disk</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {depth.map((m) => (
                    <TableRow key={m.file}>
                      <TableCell className="font-mono text-xs">{m.file}</TableCell>
                      <TableCell className="uppercase">{m.variant}</TableCell>
                      <TableCell className="capitalize">{m.environment}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {m.size_mb ? `${m.size_mb} MB` : "–"}
                      </TableCell>
                      <TableCell className="text-right">
                        <PresenceBadge present={m.present} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
