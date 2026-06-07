import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EvaluationDetailsModal, PredictionSnapshotCard } from "../../components/EvaluationDetailsModal";

vi.mock("@/components/ThresholdExplorer", () => ({
  ThresholdExplorer: () => <div data-testid="threshold-explorer-stub" />,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("PredictionSnapshotCard", () => {
  it("shows bbox-unavailable copy when bbox is null", () => {
    render(
      <PredictionSnapshotCard
        imageUrls={["http://localhost:9999/img.png"]}
        fileName="img.png"
        className="cat"
        conf={0.5}
        bbox={null}
      />
    );
    expect(screen.getByText("img.png")).toBeInTheDocument();
    expect(screen.getByText(/Bounding box unavailable for crop/)).toBeInTheDocument();
  });
});

describe("EvaluationDetailsModal", () => {
  const completedTask = {
    id: 42,
    name: "Smoke evaluation",
    status: "completed",
    progress: 100,
    created_at: "2024-01-01T00:00:00.000Z",
    completed_at: "2024-01-01T00:05:00.000Z",
    task_metadata: {
      dataset_name: "ds1",
      results: {
        precision: 0.5,
        recall: 0.5,
        f1_score: 0.5,
        map50: 0.5,
        map50_95: 0.5,
        confusion_matrix: [
          [1, 0],
          [0, 1],
        ],
        class_names: ["cat", "dog"],
        predictions_count: 1,
        has_ground_truth: false,
        avg_confidence: 0.9,
        predictions_per_image: 1,
        images_processed: 1,
        inference_time_ms: 100,
        image_id_to_filename: { "7": "sample.jpg" },
        project_id: 3,
        dataset_id: 9,
        predictions: [{ image_id: 7, class_id: 0, conf: 0.91, bbox_xyxy: [10, 10, 60, 80] }],
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads task via fetch and shows title and snapshot filename", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/tasks/42")) {
        return Promise.resolve({
          ok: true,
          json: async () => completedTask,
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<EvaluationDetailsModal open onOpenChange={vi.fn()} taskId={42} />);

    await waitFor(() => {
      expect(screen.getByText("Smoke evaluation")).toBeInTheDocument();
    });
    expect(screen.getByText("sample.jpg")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/tasks/42"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("shows error state when task fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    render(<EvaluationDetailsModal open onOpenChange={vi.fn()} taskId={1} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch evaluation details: 500/)).toBeInTheDocument();
    });
  });
});
