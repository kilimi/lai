import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { TrainingDetailsModal } from "../../components/TrainingDetailsModal";

// Mock the hooks and components
vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ api: {} }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: any) => <span>{status}</span>,
}));

vi.mock("recharts", () => ({
  LineChart: () => <div data-testid="line-chart" />,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Brain: () => <div>Brain</div>,
  TrendingUp: () => <div>TrendingUp</div>,
  Activity: () => <div>Activity</div>,
  Images: () => <div>Images</div>,
  Database: () => <div>Database</div>,
  FileBox: () => <div>FileBox</div>,
  LineChart: () => <div>LineChart</div>,
  LayoutGrid: () => <div>LayoutGrid</div>,
  Settings: () => <div>Settings</div>,
  ChevronDown: () => <div>ChevronDown</div>,
  ChevronUp: () => <div>ChevronUp</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: any) => <button data-value={value}>{children}</button>,
  TabsContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>Loading...</div>,
}));

vi.mock("@/components/TrainingMetricsCharts", () => ({
  default: () => <div>TrainingMetricsCharts</div>,
}));

vi.mock("@/utils/formatDuration", () => ({
  formatDuration: () => "1h 0m",
}));

vi.mock("@/config/api", () => ({
  getApiBaseUrl: () => "http://localhost:9999",
}));

describe("TrainingDetailsModal", () => {
  const mockTask = {
    id: 42,
    name: "YOLO training",
    status: "completed",
    progress: 100,
    created_at: "2024-01-01T00:00:00.000Z",
    completed_at: "2024-01-01T01:00:00.000Z",
    task_metadata: {
      current_epoch: 10,
      epochs: 10,
      latest_metrics: {
        epoch: 10,
        box_loss: 0.05,
        cls_loss: 0.03,
        precision: 0.85,
        recall: 0.80,
        mAP50: 0.82,
        mAP50_95: 0.60,
      },
      metrics_history: [
        {
          epoch: 1,
          box_loss: 0.5,
          cls_loss: 0.3,
          precision: 0.5,
          recall: 0.4,
          mAP50: 0.45,
          mAP50_95: 0.3,
        },
      ],
      training_params: {
        batch_size: 16,
        epochs: 10,
        img_size: 640,
      },
      class_names: ["person", "car"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fetches and displays task details when opened", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTask,
    });

    render(<TrainingDetailsModal open={true} onOpenChange={() => {}} taskId={42} />);

    await waitFor(() => {
      expect(screen.getByText("YOLO training")).toBeInTheDocument();
    });
  });

  it("displays task status and progress", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockTask,
    });

    render(<TrainingDetailsModal open={true} onOpenChange={() => {}} taskId={42} />);

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeInTheDocument();
    });
  });

  it("shows up to three clickable training example thumbnails per split", async () => {
    const taskWithExamples = {
      ...mockTask,
      task_metadata: {
        ...mockTask.task_metadata,
        example_images: {
          train: "/tasks/42/examples/train",
          val: "/tasks/42/examples/val",
        },
        image_counts: { train: 9, val: 2, test: 0 },
      },
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => taskWithExamples,
    });

    render(<TrainingDetailsModal open={true} onOpenChange={() => {}} taskId={42} />);

    await waitFor(() => {
      expect(screen.getByText("Train")).toBeInTheDocument();
    });

    const thumbs = screen.getAllByAltText(/Train example \d/);
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0].getAttribute("src")).toBe(
      "http://localhost:9999/tasks/42/examples/train/sample/1",
    );

    fireEvent.click(thumbs[0]);
    const enlarged = await screen.findAllByAltText("Train example 1");
    expect(enlarged.length).toBeGreaterThanOrEqual(1);
  });

  it("shows live in-epoch batch progress for running training", async () => {
    const runningTask = {
      ...mockTask,
      status: "running",
      progress: 41,
      task_metadata: {
        ...mockTask.task_metadata,
        current_epoch: 1,
        epochs: 100,
        total_epochs: 100,
        current_batch: 39,
        total_batches: 281,
        epoch_progress_pct: 14,
        epoch_eta_seconds: 6326,
        stage: "training",
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => runningTask,
    });

    render(<TrainingDetailsModal open={true} onOpenChange={() => {}} taskId={42} />);

    await waitFor(() => {
      expect(screen.getByText("Batch 39/281")).toBeInTheDocument();
    });

    expect(screen.getByText("14% of current epoch")).toBeInTheDocument();
    expect(screen.getAllByText(/1h 45m/).length).toBeGreaterThan(0);
  });
});
