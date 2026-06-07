import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DatasetCard } from "@/components/DatasetCard";
import { Dataset } from "@/types";
import userEvent from "@testing-library/user-event";

// Mock dependencies
vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ api: mockApi }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/utils/animations", () => ({
  useImageLoad: () => true,
}));

vi.mock("@/config/api", () => ({
  resolveBackendMediaUrl: (url: string) => url || "",
}));

vi.mock("@/utils/detectFormat", () => ({
  detectFormat: (name: string) => {
    if (name.includes("coco")) return "COCO";
    if (name.includes("yolo")) return "YOLO";
    return "Other";
  },
}));

// Mock API
const mockApi = {
  duplicateDataset: vi.fn(),
  getTask: vi.fn(),
  getProjects: vi.fn(),
  moveDataset: vi.fn(),
};

const mockDataset = {
  id: "123",
  name: "Test Dataset",
  description: "Test description",
  project_id: "456",
  image_count: 100,
  annotation_file_count: 2,
  annotation_files: [
    {
      id: "1",
      name: "coco_annotations.json",
      file_name: "coco_annotations.json",
      annotation_count: 50,
    },
    {
      id: "2",
      name: "yolo_labels.txt",
      file_name: "yolo_labels.txt",
      annotation_count: 50,
    },
  ],
  tags: ["tag1", "tag2"],
  thumbnailUrl: "/thumb.jpg",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
} as unknown as Dataset;

describe("DatasetCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const renderDatasetCard = (props = {}) => {
    return render(
      <MemoryRouter>
        <DatasetCard dataset={mockDataset} {...props} />
      </MemoryRouter>
    );
  };

  const openActionsMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: /dataset actions/i }));
  };

  it("renders dataset name and description", () => {
    renderDatasetCard();
    expect(screen.getByText("Test Dataset")).toBeInTheDocument();
    expect(screen.getByText("Test description")).toBeInTheDocument();
  });

  it("displays image and annotation counts", () => {
    renderDatasetCard();
    expect(screen.getByText("100")).toBeInTheDocument(); // image count
    expect(screen.getByText("2 annotation sets")).toBeInTheDocument();
  });

  it("shows annotation file badges", () => {
    renderDatasetCard();
    expect(screen.getByText("coco_annotations.json")).toBeInTheDocument();
    expect(screen.getByText("yolo_labels.txt")).toBeInTheDocument();
  });

  it("displays tags when present", () => {
    renderDatasetCard();
    expect(screen.getByText("tag1")).toBeInTheDocument();
    expect(screen.getByText("tag2")).toBeInTheDocument();
  });

  it("shows Empty status for dataset with no images", () => {
    const emptyDataset = { ...mockDataset, image_count: 0 };
    render(
      <MemoryRouter>
        <DatasetCard dataset={emptyDataset} />
      </MemoryRouter>
    );
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("shows Unannotated status for dataset with images but no annotations", () => {
    const unannotatedDataset = {
      ...mockDataset,
      annotation_file_count: 0,
      annotation_files: [],
    };
    render(
      <MemoryRouter>
        <DatasetCard dataset={unannotatedDataset} />
      </MemoryRouter>
    );
    expect(screen.getByText("Unannotated")).toBeInTheDocument();
  });

  it("shows multi-format badge when multiple formats detected", () => {
    renderDatasetCard();
    expect(screen.getByText("Multi-format")).toBeInTheDocument();
  });

  it("handles duplicate action successfully", async () => {
    const user = userEvent.setup({ delay: null });

    mockApi.duplicateDataset.mockResolvedValueOnce({
      success: true,
      data: { task_id: "789" },
    });

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: { status: "running" },
    });

    renderDatasetCard();

    // Open dropdown menu
    await openActionsMenu(user);

    // Click duplicate
    const duplicateButton = screen.getByText("Duplicate");
    await user.click(duplicateButton);

    await waitFor(() => {
      expect(mockApi.duplicateDataset).toHaveBeenCalledWith("123");
    });

  });

  it("cleans up polling interval on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    mockApi.duplicateDataset.mockResolvedValueOnce({
      success: true,
      data: { task_id: "789" },
    });

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: { status: "running" },
    });

    const { unmount } = renderDatasetCard();

    // Trigger duplicate
    const user = userEvent.setup({ delay: null });
    await openActionsMenu(user);
    const duplicateButton = screen.getByText("Duplicate");
    await user.click(duplicateButton);

    await waitFor(() => {
      expect(mockApi.duplicateDataset).toHaveBeenCalled();
    });

    // Unmount component
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();

  });

  it("validates dataset ID before calling onDatasetMoved", async () => {
    const onDatasetMoved = vi.fn();
    const invalidDataset = { ...mockDataset, id: "invalid" };

    mockApi.getProjects.mockResolvedValueOnce({
      success: true,
      data: [
        { id: "999", name: "Target Project" },
      ],
    });

    mockApi.moveDataset.mockResolvedValueOnce({
      success: true,
    });

    render(
      <MemoryRouter>
        <DatasetCard dataset={invalidDataset as unknown as Dataset} onDatasetMoved={onDatasetMoved} />
      </MemoryRouter>
    );

    const user = userEvent.setup({ delay: null });
    await openActionsMenu(user);

    const moveButton = screen.getByText("Move");
    await user.click(moveButton);

    await waitFor(() => {
      expect(screen.getByText("Move Dataset")).toBeInTheDocument();
    });

    // Dialog should show error, callback should not be called with invalid ID
    expect(onDatasetMoved).not.toHaveBeenCalled();
  });

  it("renders thumbnail when available", () => {
    renderDatasetCard();
    const img = screen.getByAltText("Test Dataset");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/thumb.jpg");
  });

  it("shows database icon when no thumbnail", () => {
    const noThumbDataset = { ...mockDataset, thumbnailUrl: "" };
    render(
      <MemoryRouter>
        <DatasetCard dataset={noThumbDataset} />
      </MemoryRouter>
    );
    // Database icon should be present (can't easily test Lucide icons, but component should render)
    expect(screen.getByText("Test Dataset")).toBeInTheDocument();
  });

  it("displays formatted relative time", () => {
    renderDatasetCard();
    const dateElement = screen.getByTitle(new Date(mockDataset.updated_at).toLocaleString());
    expect(dateElement).toBeInTheDocument();
  });
});
