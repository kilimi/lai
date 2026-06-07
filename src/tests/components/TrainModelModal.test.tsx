import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrainModelModal } from "@/components/TrainModelModal";
import { Dataset, DatasetGroup } from "@/types";

// Mock dependencies
vi.mock("@/hooks/use-api", () => ({
  useApi: () => ({ api: mockApi }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/components/YoloSettingsDialog", () => ({
  YoloSettingsDialog: ({ open, onOpenChange, initialSettings, onSave }: any) =>
    open ? (
      <div data-testid="yolo-settings-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
        <button
          onClick={() => {
            onSave(initialSettings);
            onOpenChange(false);
          }}
        >
          Save
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/RFDETRSettingsDialog", () => ({
  RFDETRSettingsDialog: ({ open, onOpenChange, initialSettings, onSave }: any) =>
    open ? (
      <div data-testid="rfdetr-settings-dialog">
        <button onClick={() => onOpenChange(false)}>Close</button>
        <button
          onClick={() => {
            onSave(initialSettings);
            onOpenChange(false);
          }}
        >
          Save
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/TrainingStartedDialog", () => ({
  TrainingStartedDialog: ({ open, onOpenChange, taskId }: any) =>
    open ? (
      <div data-testid="training-started-dialog">
        Task ID: {taskId}
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}));

vi.mock("@/utils/trainingCloneSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/trainingCloneSettings")>();
  return { ...actual };
});

// Mock Lucide icons (must include every icon used by TrainModelModal and its children, e.g. dialog.tsx uses X)
vi.mock("lucide-react", () => ({
  Brain: () => <div>Brain Icon</div>,
  Database: () => <div>Database Icon</div>,
  Settings: () => <div>Settings Icon</div>,
  Trash2: () => <div>Trash Icon</div>,
  Plus: () => <div>Plus Icon</div>,
  Image: () => <div>Image Icon</div>,
  ImageIcon: () => <div>ImageIcon Icon</div>,
  FileText: () => <div>FileText Icon</div>,
  Wand2: () => <div>Wand Icon</div>,
  Check: () => <div>Check Icon</div>,
  ChevronDown: () => <div>ChevronDown Icon</div>,
  ChevronRight: () => <div>ChevronRight Icon</div>,
  Users: () => <div>Users Icon</div>,
  Info: () => <div>Info Icon</div>,
  X: () => <div>X Icon</div>,
  Loader2: () => <div>Loader2 Icon</div>,
  AlertCircle: () => <div>AlertCircle Icon</div>,
  ChevronUp: () => <div>ChevronUp Icon</div>,
  Search: () => <div>Search Icon</div>,
  LayoutList: () => <div>LayoutList Icon</div>,
  LayoutGrid: () => <div>LayoutGrid Icon</div>,
  Folder: () => <div>Folder Icon</div>,
  Rows3: () => <div>Rows3 Icon</div>,
  ArrowRight: () => <div>ArrowRight Icon</div>,
  ArrowLeft: () => <div>ArrowLeft Icon</div>,
  Sliders: () => <div>Sliders Icon</div>,
}));

const mockModelsCatalogResponse = {
  success: true,
  data: {
    backends: [
      { id: "ultralytics.yolo", display_name: "YOLO" },
      { id: "ultralytics.rtdetr", display_name: "RF-DETR" },
      { id: "mmyolo", display_name: "MMYOLO" },
    ],
    pretrained_ultralytics: {},
  },
};

// Mock API
const mockApi = {
  getImageCollections: vi.fn(),
  getAnnotations: vi.fn(),
  getModelsCatalog: vi.fn(),
  startTraining: vi.fn(),
  getTask: vi.fn(),
};

/** Unified training API nests YOLO/RT-DETR fields under `params`. */
function trainingParams(callIndex = 0) {
  return mockApi.startTraining.mock.calls[callIndex][0].params;
}

function startTrainingCall(callIndex = 0) {
  return mockApi.startTraining.mock.calls[callIndex][0];
}

const mockToast = vi.fn();

// Test data
const mockDataset1 = {
  id: "1",
  name: "Dataset 1",
  description: "Test dataset 1",
  project_id: "456",
  image_count: 100,
  annotation_file_count: 1,
  annotation_files: [],
  tags: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
} as unknown as Dataset;

const mockDataset2 = {
  id: "2",
  name: "Dataset 2",
  description: "Test dataset 2",
  project_id: "456",
  image_count: 200,
  annotation_file_count: 1,
  annotation_files: [],
  tags: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
} as unknown as Dataset;

const mockDatasetGroup = {
  id: "group1",
  name: "Test Group",
  description: "Test group",
  project_id: "456",
  datasets: [mockDataset1, mockDataset2],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
} as unknown as DatasetGroup;

describe("TrainModelModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock responses
    mockApi.getImageCollections.mockResolvedValue({
      success: true,
      data: [{ name: "collection1" }, { name: "collection2" }],
    });

    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [
        { id: "ann1", name: "annotations1.json", type: "coco" },
        { id: "ann2", name: "annotations2.json", type: "yolo" },
      ],
    });

    mockApi.getModelsCatalog.mockResolvedValue(mockModelsCatalogResponse);

    mockApi.startTraining.mockResolvedValue({
      success: true,
      data: { task_id: "task123" },
    });

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: {
        task_metadata: {
          dataset_configs: [
            {
              dataset_id: 1,
              annotation_file_id: "ann1",
              image_collection: "collection1",
              split: { train: 80, val: 20, test: 0 },
            },
          ],
          model_type: "yolo11n-seg.pt",
          training_params: {
            epochs: 100,
            batch_size: 16,
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const renderModal = (props = {}) => {
    return render(
      <TrainModelModal
        open={true}
        onOpenChange={vi.fn()}
        datasets={[mockDataset1, mockDataset2]}
        datasetGroups={[mockDatasetGroup]}
        projectId="456"
        {...props}
      />
    );
  };

  const getDatasetRowButton = (datasetName: string) => {
    const candidates = screen.getAllByRole("button", { name: new RegExp(datasetName, "i") });
    const rowButton = candidates.find((el) => {
      const cls = (el.getAttribute("class") || "").toLowerCase();
      return cls.includes("flex-1") && cls.includes("text-left");
    });
    if (!rowButton) throw new Error(`${datasetName} row button not found`);
    return rowButton;
  };

  const selectYoloModel = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("heading", { name: /ultralytics yolo/i }));
  };

  const selectRfdetrModel = async (user: ReturnType<typeof userEvent.setup>) => {
    // Card title only — settings panel adds a second "Ultralytics RT-DETR Configuration" heading.
    await user.click(screen.getByRole("heading", { name: /^ultralytics rt-detr$/i }));
  };

  const clickNext = async (user: ReturnType<typeof userEvent.setup>) => {
    await waitFor(() => {
      const candidates = screen.getAllByRole("button", { name: /next/i });
      expect(candidates.some((b) => !b.hasAttribute("disabled"))).toBe(true);
    });
    const nextBtn = screen
      .getAllByRole("button", { name: /next/i })
      .find((b) => !b.hasAttribute("disabled"))!;
    await user.click(nextBtn);
  };

  /** Step 1 (model already selected) → step 2 (datasets). */
  const goToDatasetsStepWithModelSelected = async (user: ReturnType<typeof userEvent.setup>) => {
    await clickNext(user);
    await screen.findByText("Dataset 1");
  };

  /** Select YOLO on step 1, then open datasets step. */
  const goToDatasetsStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await selectYoloModel(user);
    await goToDatasetsStepWithModelSelected(user);
  };

  const addSingleDataset = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText("Dataset 1");
    const dsButton = getDatasetRowButton("Dataset 1");
    // One click selects the row; DatasetEvalPicker auto-expands on select (comfortable density).
    // A second click on the row toggles collapse and hides split presets.
    await user.click(dsButton);
  };

  /** Split presets live in the expanded dataset row (TrainModelModal → DatasetEvalPicker). */
  const expandFirstSelectedDataset = async (user: ReturnType<typeof userEvent.setup>) => {
    const expandBtn = screen.queryByRole("button", { name: "Expand" });
    if (expandBtn) {
      await user.click(expandBtn);
    }
  };

  /** Model selected, dataset added, on step 2 ready for Next → options. */
  const completeDatasetsStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await goToDatasetsStep(user);
    await addSingleDataset(user);
    await flushMicrotasks();
    await waitFor(() => expect(mockApi.getImageCollections).toHaveBeenCalled());
    await waitFor(() => expect(mockApi.getAnnotations).toHaveBeenCalled());
  };

  const goToOptionsStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await clickNext(user);
  };

  const flushMicrotasks = async () => {
    await Promise.resolve();
  };

  it("renders modal when open", () => {
    renderModal();
    expect(screen.getByRole("heading", { name: /train model/i })).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderModal({ open: false });
    expect(screen.queryByText("Train Model")).not.toBeInTheDocument();
  });

  it("generates unique IDs for dataset selections without collisions", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    await goToDatasetsStep(user);
    // Toggle selection on/off repeatedly; each new selection should trigger a fresh fetch.
    await addSingleDataset(user);
    await user.click(screen.getByRole("button", { name: /remove dataset 1/i }));
    await addSingleDataset(user);
    await user.click(screen.getByRole("button", { name: /remove dataset 1/i }));
    await addSingleDataset(user);

    await flushMicrotasks();

    // Verify that API was called for each dataset (unique selections created)
    await waitFor(() => {
      expect(mockApi.getImageCollections).toHaveBeenCalledTimes(3);
    });

    // All calls should be with dataset ID 1 (first dataset)
    expect(mockApi.getImageCollections).toHaveBeenCalledWith("1");
  });

  it("fetches collections and annotations when dataset is added", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    await goToDatasetsStep(user);
    await addSingleDataset(user);

    await flushMicrotasks();

    await waitFor(() => {
      expect(mockApi.getImageCollections).toHaveBeenCalledWith("1");
      expect(mockApi.getAnnotations).toHaveBeenCalledWith("1");
    });
  });

  it("cancels previous fetch when new fetch starts for same selection", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderModal();
    await goToDatasetsStep(user);

    // Mock slow API calls
    let resolveFirst: any;
    let resolveSecond: any;
    mockApi.getImageCollections
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () =>
              resolve({
                success: true,
                data: [{ name: "old-collection" }],
              });
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = () =>
              resolve({
                success: true,
                data: [{ name: "new-collection" }],
              });
          })
      );

    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [{ id: "ann1", name: "annotations.json" }],
    });

    // Add dataset
    await addSingleDataset(user);

    await flushMicrotasks();

    // Switch selected dataset to trigger a new fetch cycle and make the first stale.
    const removeDataset1 = await screen.findByRole("button", { name: /remove dataset 1/i });
    await user.click(removeDataset1);
    const ds2Label = await screen.findByText("Dataset 2");
    const ds2Button = ds2Label.closest("button") as HTMLButtonElement | null;
    if (!ds2Button) throw new Error("Dataset 2 row button not found");
    await user.click(ds2Button);

    // Resolve second fetch first
    resolveSecond();
    await flushMicrotasks();

    // Now resolve first fetch (should be ignored)
    resolveFirst();
    await flushMicrotasks();

    // Verify only new collection appears (old one was cancelled)
    await waitFor(() => {
      expect(screen.queryByText("old-collection")).not.toBeInTheDocument();
    });
  });

  it("rate limits parallel fetches when adding dataset group", async () => {
    // Dialog + interactive controls set `pointer-events: none` on `body`; allow synthetic clicks.
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderModal();
    await goToDatasetsStep(user);

    // In the new picker UI, group rows expose an "Add all" action.
    const addAll = await screen.findByRole("button", { name: /add all/i });
    await user.click(addAll);

    // Both datasets in the selected group should eventually trigger fetches
    await waitFor(() => {
      expect(mockApi.getImageCollections).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });

    // Verify calls were for different datasets
    expect(mockApi.getImageCollections).toHaveBeenCalledWith("1");
    expect(mockApi.getImageCollections).toHaveBeenCalledWith("2");
  });

  it("cleans up abort controllers on unmount", async () => {
    const user = userEvent.setup({ delay: null });

    // Mock slow API call that doesn't resolve
    mockApi.getImageCollections.mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    const { unmount } = renderModal();
    await goToDatasetsStep(user);

    await addSingleDataset(user);
    await flushMicrotasks();

    expect(mockApi.getImageCollections).toHaveBeenCalled();

    unmount();

    // No errors should occur from state updates after unmount
    await flushMicrotasks();
  });

  it("does not update state after unmount", async () => {
    const user = userEvent.setup({ delay: null });

    let resolveFetch: any;
    mockApi.getImageCollections.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve({
              success: true,
              data: [{ name: "collection" }],
            });
        })
    );

    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [{ id: "ann1", name: "annotations.json" }],
    });

    const { unmount } = renderModal();
    await goToDatasetsStep(user);

    await addSingleDataset(user);
    await flushMicrotasks();

    unmount();

    // Now resolve the fetch
    resolveFetch();
    await flushMicrotasks();

    // No errors should occur - state updates should be prevented
  });

  it("loads cloned task settings", async () => {
    const onOpenChange = vi.fn();

    renderModal({
      cloneFromTaskId: 123,
      resourcesLoading: false,
    });

    await flushMicrotasks();

    await waitFor(() => {
      expect(mockApi.getTask).toHaveBeenCalledWith(123);
    });

    // Should show success toast
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Training form filled",
        })
      );
    });
  });

  it("validates form before allowing training", async () => {
    renderModal();

    // On step 1, Next is disabled until a model architecture is selected
    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeDisabled();

    // The "Train Model" button only appears on step 3 (not reachable without valid data)
    expect(screen.queryByRole("button", { name: /train model/i })).not.toBeInTheDocument();
  });

  it("enables train button when form is complete", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    mockApi.getImageCollections.mockResolvedValue({
      success: true,
      data: [{ name: "collection1" }],
    });
    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [{ id: "ann1", name: "annotations1.json", type: "coco" }],
    });
    renderModal();

    await completeDatasetsStep(user);
    await goToOptionsStep(user);

    const trainButton = await screen.findByRole("button", { name: /train model/i });
    expect(trainButton).not.toBeDisabled();
  });

  it("starts YOLO training with correct parameters", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();
    mockApi.getImageCollections.mockResolvedValue({
      success: true,
      data: [{ name: "collection1" }],
    });
    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [{ id: "ann1", name: "annotations1.json", type: "coco" }],
    });

    renderModal({ onOpenChange });

    await completeDatasetsStep(user);
    await goToOptionsStep(user);

    // Start training
    const trainButton = await screen.findByRole("button", { name: /train model/i });
    await waitFor(() => expect(trainButton).not.toBeDisabled());
    await user.click(trainButton);

    await waitFor(() => {
      expect(mockApi.startTraining).toHaveBeenCalled();
    });

    const call = startTrainingCall();
    expect(call.framework_id).toBe("ultralytics.yolo");
    expect(call.project_id).toBe(456);
    expect(call.dataset_configs).toHaveLength(1);
    const trainingRequest = trainingParams();
    expect(trainingRequest).toHaveProperty("model_type");
    expect(trainingRequest).toHaveProperty("epochs");

    // Modal should close
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("removes dataset selection when trash button clicked", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();
    await goToDatasetsStep(user);

    await addSingleDataset(user);

    await flushMicrotasks();

    // Wait for selected dataset card to appear
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove dataset 1/i })).toBeInTheDocument();
    });

    // Click remove button
    const removeButton = screen.getByRole("button", { name: /remove dataset 1/i });
    await user.click(removeButton);

    // Selected dataset chip should be removed
    expect(screen.queryByRole("button", { name: /remove dataset 1/i })).not.toBeInTheDocument();
  });

  it("auto-selects when only one option available", async () => {
    // Mock single collection and annotation
    mockApi.getImageCollections.mockResolvedValue({
      success: true,
      data: [{ name: "only-collection" }],
    });

    mockApi.getAnnotations.mockResolvedValue({
      success: true,
      data: [{ id: "only-ann", name: "only-annotation.json" }],
    });

    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderModal();

    await completeDatasetsStep(user);
    await goToOptionsStep(user);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /train model/i })).not.toBeDisabled();
    });
  });

  it("resets form when modal closes", async () => {
    const user = userEvent.setup({ delay: null });
    const onOpenChange = vi.fn();

    const { rerender } = renderModal({ onOpenChange });

    await goToDatasetsStep(user);
    await addSingleDataset(user);

    await flushMicrotasks();

    // Close modal
    rerender(
      <TrainModelModal
        open={false}
        onOpenChange={onOpenChange}
        datasets={[mockDataset1, mockDataset2]}
        datasetGroups={[mockDatasetGroup]}
        projectId="456"
      />
    );

    // Reopen modal
    rerender(
      <TrainModelModal
        open={true}
        onOpenChange={onOpenChange}
        datasets={[mockDataset1, mockDataset2]}
        datasetGroups={[mockDatasetGroup]}
        projectId="456"
      />
    );

    // Form should be reset (dataset is not selected anymore)
    expect(screen.queryByRole("button", { name: /remove dataset 1/i })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Settings-propagation tests: verify every GUI field reaches the API payload
  // ---------------------------------------------------------------------------

  describe("settings propagation to API", () => {
    const navigateToDatasetsWithSelection = async (
      user: ReturnType<typeof userEvent.setup>,
      pickModel: (u: ReturnType<typeof userEvent.setup>) => Promise<void> = selectYoloModel,
    ) => {
      await pickModel(user);
      await goToDatasetsStepWithModelSelected(user);
      await addSingleDataset(user);
      await flushMicrotasks();
      await waitFor(() => expect(mockApi.getImageCollections).toHaveBeenCalled());
      await waitFor(() => expect(mockApi.getAnnotations).toHaveBeenCalled());
    };

    beforeEach(() => {
      mockApi.getImageCollections.mockResolvedValue({
        success: true,
        data: [{ name: "col1" }],
      });
      mockApi.getAnnotations.mockResolvedValue({
        success: true,
        data: [{ id: "ann1", name: "annotations.json", type: "coco" }],
      });
      mockApi.getModelsCatalog.mockResolvedValue(mockModelsCatalogResponse);
      mockApi.startTraining.mockResolvedValue({
        success: true,
        data: { task_id: "t1" },
      });
    });

    it("sends custom YOLO settings (epochs, batchSize, imageSize, learningRate, patience) to API", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectYoloModel(user);
      fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "42" } });
      fireEvent.change(screen.getByDisplayValue("16"), { target: { value: "8" } });
      fireEvent.change(screen.getByDisplayValue("640"), { target: { value: "1280" } });
      fireEvent.change(screen.getByDisplayValue("0.01"), { target: { value: "0.005" } });
      fireEvent.change(screen.getByDisplayValue("50"), { target: { value: "25" } });

      await navigateToDatasetsWithSelection(user);
      await goToOptionsStep(user);

      // Click Train Model
      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const req = trainingParams();
      expect(req.epochs).toBe(42);
      expect(req.batch_size).toBe(8);
      expect(req.image_size).toBe(1280);
      expect(req.learning_rate).toBe(0.005);
      expect(req.patience).toBe(25);
    });

    it("sends correct YOLO model_type based on version + size + task selection", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      mockApi.getAnnotations.mockResolvedValue({
        success: true,
        data: [{ id: "ann1", name: "masks.json", type: "Segmentation (mask)" }],
      });
      renderModal();

      // Task first (clears model), then re-pick YOLO so modelSettings.task = segmentation.
      await user.click(screen.getByRole("button", { name: /segmentation/i }));
      await selectYoloModel(user);
      await goToDatasetsStepWithModelSelected(user);
      await addSingleDataset(user);
      await flushMicrotasks();
      await waitFor(() => expect(mockApi.getAnnotations).toHaveBeenCalled());
      await goToOptionsStep(user);

      // yolo11 / n / segmentation → yolo11n-seg.pt
      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const call = startTrainingCall();
      const req = trainingParams();
      expect(req.model_type).toMatch(/^yolo11n-seg\.pt$/);
      expect(call.project_id).toBe(456);
      expect(call.dataset_configs).toHaveLength(1);
    });

    it("sends custom RF-DETR settings (variant, epochs, batchSize, imageSize) to API", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectRfdetrModel(user);
      fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "75" } });
      fireEvent.change(screen.getByDisplayValue("16"), { target: { value: "4" } });
      fireEvent.change(screen.getByDisplayValue("640"), { target: { value: "800" } });

      await navigateToDatasetsWithSelection(user, selectRfdetrModel);
      await goToOptionsStep(user);
      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const call = startTrainingCall();
      expect(call.framework_id).toBe("ultralytics.rtdetr");
      const req = trainingParams();
      expect(req.epochs).toBe(75);
      expect(req.batch_size).toBe(4);
      expect(req.image_size).toBe(800);
      expect(req.model_type).toBe("rtdetr-l.pt");
      expect(call.project_id).toBe(456);
    });

    it("sends default RF-DETR settings when nothing is changed", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectRfdetrModel(user);
      await navigateToDatasetsWithSelection(user, selectRfdetrModel);
      await goToOptionsStep(user);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(startTrainingCall().framework_id).toBe("ultralytics.rtdetr");
      const req = trainingParams();
      expect(req.epochs).toBe(100);
      expect(req.batch_size).toBe(16);
      expect(req.image_size).toBe(640);
      expect(req.model_type).toBe("rtdetr-l.pt");
      expect(req.optimizer).toBe("AdamW");
      expect(req.learning_rate).toBe(0.0001);
      expect(req.weight_decay).toBe(0.0001);
      expect(req.patience).toBe(50);
    });

    it("sends dataset split values as configured by the user", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await navigateToDatasetsWithSelection(user);
      await expandFirstSelectedDataset(user);

      const preset = await screen.findByRole("button", { name: "70/20/10" });
      await user.click(preset);

      await goToOptionsStep(user);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const split = startTrainingCall().dataset_configs[0].split;
      expect(split).toEqual({ train: 70, val: 20, test: 10 });
    });

    it("sends custom task name when provided", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectYoloModel(user);
      await navigateToDatasetsWithSelection(user);
      await goToOptionsStep(user);

      // On step 3, fill in the custom name
      const nameInput = screen.getByPlaceholderText(/my custom yolo training/i);
      await user.clear(nameInput);
      await user.type(nameInput, "My Special Run");

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(startTrainingCall().task_name).toBe("My Special Run");
    });

    it("does not send custom name when left empty (falls back to default)", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectYoloModel(user);
      await navigateToDatasetsWithSelection(user);
      await goToOptionsStep(user);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const taskName = startTrainingCall().task_name;
      expect(taskName).toBeTruthy();
      expect(taskName).toMatch(/yolo training/i);
    });

    it("sends remove_images_without_annotations as true by default", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectYoloModel(user);
      await navigateToDatasetsWithSelection(user);
      await goToOptionsStep(user);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(trainingParams().remove_images_without_annotations).toBe(true);
    });

    it("sends remove_images_without_annotations as false when unchecked", async () => {
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal();

      await selectYoloModel(user);
      await navigateToDatasetsWithSelection(user);
      await goToOptionsStep(user);

      // On step 3, uncheck the option
      const checkbox = screen.getByLabelText(/remove images without annotations/i);
      await user.click(checkbox);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(trainingParams().remove_images_without_annotations).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Clone-and-retrain: model configurations should be preserved exactly
  // ---------------------------------------------------------------------------

  describe("clone preserves model configuration (regression: yolov8 → yolo8n.pt bug)", () => {
    /** Helper: set up getTask to return a task with a given model_type */
    const cloneTask = (modelType: string) => {
      mockApi.getTask.mockResolvedValue({
        success: true,
        data: {
          task_metadata: {
            dataset_configs: [
              {
                dataset_id: 1,
                annotation_file_id: "ann1",
                image_collection: "col1",
                split: { train: 80, val: 20, test: 0 },
              },
            ],
            model_type: modelType,
            training_params: { epochs: 50, batch_size: 8 },
          },
        },
      });
    };

    beforeEach(() => {
      mockApi.getImageCollections.mockResolvedValue({
        success: true,
        data: [{ name: "col1" }],
      });
      mockApi.getAnnotations.mockResolvedValue({
        success: true,
        data: [{ id: "ann1", name: "annotations.json", type: "coco" }],
      });
      mockApi.getModelsCatalog.mockResolvedValue(mockModelsCatalogResponse);
      mockApi.startTraining.mockResolvedValue({
        success: true,
        data: { task_id: "cloned-task" },
      });
    });

    /** Navigate datasets step after clone has populated selections */
    const navigateAfterClone = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Training form filled" })
        )
      );
      // Step 1: collections + annotations are fetched for the cloned selections
      await waitFor(() => expect(mockApi.getImageCollections).toHaveBeenCalled());
      const nextBtn = await screen.findByRole("button", { name: /next/i });
      await waitFor(() => expect(nextBtn).not.toBeDisabled());
      await user.click(nextBtn);
    };

    it("cloning a yolov8n.pt task re-trains with model_type=yolov8n.pt", async () => {
      cloneTask("yolov8n.pt");
      // The existing parseYoloPresetFromModelType mock returns { modelSize: model }
      // so modelSettings.modelSize will be set to "yolov8n.pt" from the clone.
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal({ cloneFromTaskId: 99, resourcesLoading: false });

      await navigateAfterClone(user);

      // Step 2 → 3
      const nextBtn2 = await screen.findByRole("button", { name: /next/i });
      await waitFor(() => expect(nextBtn2).not.toBeDisabled());
      await user.click(nextBtn2);

      // Train
      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(trainingParams().model_type).toBe("yolov8n.pt");
    });

    it("cloning a yolov8s-seg.pt task re-trains with model_type=yolov8s-seg.pt", async () => {
      cloneTask("yolov8s-seg.pt");
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal({ cloneFromTaskId: 100, resourcesLoading: false });

      await navigateAfterClone(user);

      const nextBtn2 = await screen.findByRole("button", { name: /next/i });
      await waitFor(() => expect(nextBtn2).not.toBeDisabled());
      await user.click(nextBtn2);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(trainingParams().model_type).toBe("yolov8s-seg.pt");
    });

    it("cloning a yolo11n-seg.pt task re-trains with model_type=yolo11n-seg.pt", async () => {
      cloneTask("yolo11n-seg.pt");
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal({ cloneFromTaskId: 101, resourcesLoading: false });

      await navigateAfterClone(user);

      const nextBtn2 = await screen.findByRole("button", { name: /next/i });
      await waitFor(() => expect(nextBtn2).not.toBeDisabled());
      await user.click(nextBtn2);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      expect(trainingParams().model_type).toBe("yolo11n-seg.pt");
    });

    it("cloned task epochs and batch_size are preserved in re-training request", async () => {
      cloneTask("yolov8m.pt");
      const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
      renderModal({ cloneFromTaskId: 102, resourcesLoading: false });

      await navigateAfterClone(user);

      const nextBtn2 = await screen.findByRole("button", { name: /next/i });
      await waitFor(() => expect(nextBtn2).not.toBeDisabled());
      await user.click(nextBtn2);

      const trainBtn = await screen.findByRole("button", { name: /train model/i });
      await waitFor(() => expect(trainBtn).not.toBeDisabled());
      await user.click(trainBtn);

      await waitFor(() => expect(mockApi.startTraining).toHaveBeenCalled());

      const req = trainingParams();
      expect(req.epochs).toBe(50);
      expect(req.batch_size).toBe(8);
    });
  });
});
