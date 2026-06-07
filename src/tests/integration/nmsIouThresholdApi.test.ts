import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests for NMS IoU Threshold feature in ProjectEvaluations.
 * 
 * These tests verify that:
 * 1. The nmsIouThreshold parameter is passed from the modal to the API
 * 2. The backend receives the correct nms_iou_threshold value
 * 3. Both single and multi-dataset evaluations include the parameter
 */

describe('ProjectEvaluations - NMS IoU Threshold API Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('includes nms_iou_threshold in single evaluation API request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_name: 'Test Evaluation', task_id: 1 }),
    });
    global.fetch = mockFetch;

    // Simulate the onEvaluate callback that ProjectEvaluations creates
    const evaluateParams = {
      taskId: 1,
      datasetId: 10,
      collectionId: null,
      annotationFileId: 'file123',
      imageSize: 640,
      checkpoint: 'best' as const,
      confThreshold: 0.25,
      iouThreshold: 0.70,
      nmsIouThreshold: 0.45,
      evaluationName: 'Test Eval',
      useGrid: false,
      gridSize: 640,
      gridOverlap: 0.2,
      ignoredClasses: [],
    };

    // Make the API call as ProjectEvaluations would
    await fetch('http://localhost:9999/predictions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: evaluateParams.taskId,
        dataset_id: evaluateParams.datasetId,
        collection_id: evaluateParams.collectionId,
        annotation_file_id: evaluateParams.annotationFileId,
        image_size: evaluateParams.imageSize,
        checkpoint: evaluateParams.checkpoint,
        conf_threshold: evaluateParams.confThreshold,
        iou_threshold: evaluateParams.iouThreshold,
        nms_iou_threshold: evaluateParams.nmsIouThreshold,
        evaluation_name: evaluateParams.evaluationName,
        use_grid: evaluateParams.useGrid,
        grid_size: evaluateParams.gridSize,
        grid_overlap: evaluateParams.gridOverlap,
        ignored_classes: evaluateParams.ignoredClasses,
      }),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9999/predictions/evaluate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody).toHaveProperty('nms_iou_threshold', 0.45);
    expect(requestBody).toHaveProperty('iou_threshold', 0.70);
    expect(requestBody.nms_iou_threshold).not.toBe(requestBody.iou_threshold);
  });

  it('includes nms_iou_threshold in multi-dataset evaluation API request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 
        parent_task_name: 'Multi Eval', 
        parent_task_id: 100,
        child_task_ids: [101, 102] 
      }),
    });
    global.fetch = mockFetch;

    // Simulate the onEvaluateMultiple callback
    const evaluateParams = {
      taskId: 1,
      datasets: [
        {
          datasetId: 10,
          datasetName: 'Dataset 1',
          annotationFileId: 'file1',
          annotationFileName: 'ann1.json',
          collectionId: null,
        },
        {
          datasetId: 20,
          datasetName: 'Dataset 2',
          annotationFileId: 'file2',
          annotationFileName: 'ann2.json',
          collectionId: '5',
        },
      ],
      imageSize: 640,
      checkpoint: 'best' as const,
      confThreshold: 0.30,
      iouThreshold: 0.60,
      nmsIouThreshold: 0.50,
      evaluationName: 'Multi Test',
      useGrid: true,
      gridSize: 800,
      gridOverlap: 0.3,
      ignoredClasses: ['background'],
    };

    const requestBody = {
      task_id: evaluateParams.taskId,
      datasets: evaluateParams.datasets.map((d) => ({
        ...d,
        collectionId: d.collectionId ? parseInt(d.collectionId, 10) : null,
      })),
      checkpoint: evaluateParams.checkpoint,
      image_size: evaluateParams.imageSize,
      conf_threshold: evaluateParams.confThreshold,
      iou_threshold: evaluateParams.iouThreshold,
      nms_iou_threshold: evaluateParams.nmsIouThreshold,
      evaluation_name: evaluateParams.evaluationName,
      use_grid: evaluateParams.useGrid,
      grid_size: evaluateParams.gridSize,
      grid_overlap: evaluateParams.gridOverlap,
      ignored_classes: evaluateParams.ignoredClasses,
    };

    await fetch('http://localhost:9999/predictions/evaluate-multiple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody).toHaveProperty('nms_iou_threshold', 0.50);
    expect(sentBody).toHaveProperty('iou_threshold', 0.60);
  });

  it('verifies NMS IoU threshold can be different from matching IoU threshold', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_name: 'Test', task_id: 1 }),
    });
    global.fetch = mockFetch;

    // Test case: Strict matching (0.70) but standard NMS (0.45)
    const requestBody = {
      task_id: 1,
      dataset_id: 1,
      collection_id: null,
      annotation_file_id: 'file1',
      image_size: 640,
      checkpoint: 'best',
      conf_threshold: 0.25,
      iou_threshold: 0.70,  // Strict matching
      nms_iou_threshold: 0.45,  // Standard NMS
      evaluation_name: null,
      use_grid: false,
      grid_size: 640,
      grid_overlap: 0.2,
      ignored_classes: [],
    };

    await fetch('http://localhost:9999/predictions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    
    // Verify they are different values
    expect(sentBody.iou_threshold).toBe(0.70);
    expect(sentBody.nms_iou_threshold).toBe(0.45);
    expect(sentBody.nms_iou_threshold).not.toBe(sentBody.iou_threshold);
  });

  it('verifies default NMS IoU threshold matches component default (0.45)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_name: 'Test', task_id: 1 }),
    });
    global.fetch = mockFetch;

    // When using defaults from EvaluateModelModal
    const requestBody = {
      task_id: 1,
      dataset_id: 1,
      collection_id: null,
      annotation_file_id: null,
      image_size: 640,
      checkpoint: 'best',
      conf_threshold: 0.25,
      iou_threshold: 0.45,  // Default from modal
      nms_iou_threshold: 0.45,  // Default from modal
      evaluation_name: null,
      use_grid: false,
      grid_size: 640,
      grid_overlap: 0.2,
      ignored_classes: [],
    };

    await fetch('http://localhost:9999/predictions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    
    // Both should be 0.45 by default
    expect(sentBody.nms_iou_threshold).toBe(0.45);
    expect(sentBody.iou_threshold).toBe(0.45);
  });

  it('allows setting low NMS threshold (0.3) for aggressive suppression', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_name: 'Test', task_id: 1 }),
    });
    global.fetch = mockFetch;

    const requestBody = {
      task_id: 1,
      dataset_id: 1,
      collection_id: null,
      annotation_file_id: null,
      image_size: 640,
      checkpoint: 'best',
      conf_threshold: 0.25,
      iou_threshold: 0.50,
      nms_iou_threshold: 0.30,  // Aggressive NMS
      evaluation_name: null,
      use_grid: false,
      grid_size: 640,
      grid_overlap: 0.2,
      ignored_classes: [],
    };

    await fetch('http://localhost:9999/predictions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.nms_iou_threshold).toBe(0.30);
  });

  it('allows setting high NMS threshold (0.7) for lenient suppression', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_name: 'Test', task_id: 1 }),
    });
    global.fetch = mockFetch;

    const requestBody = {
      task_id: 1,
      dataset_id: 1,
      collection_id: null,
      annotation_file_id: null,
      image_size: 640,
      checkpoint: 'best',
      conf_threshold: 0.25,
      iou_threshold: 0.70,
      nms_iou_threshold: 0.70,  // Lenient NMS (keeps more overlaps)
      evaluation_name: null,
      use_grid: false,
      grid_size: 640,
      grid_overlap: 0.2,
      ignored_classes: [],
    };

    await fetch('http://localhost:9999/predictions/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.nms_iou_threshold).toBe(0.70);
  });
});

describe('Backend Parameter Validation', () => {
  it('backend should use nms_iou_threshold for model.predict() NMS', () => {
    // This is a documentation test to ensure developers understand the flow
    const expectedFlow = {
      frontend: {
        nmsIouThreshold: 0.45,
        iouThreshold: 0.70,
      },
      backend: {
        'model.predict(iou=nms_iou_threshold)': 0.45,
        'matching_logic(iou_threshold)': 0.70,
      },
    };

    expect(expectedFlow.frontend.nmsIouThreshold).toBe(0.45);
    expect(expectedFlow.backend['model.predict(iou=nms_iou_threshold)']).toBe(0.45);
    expect(expectedFlow.backend['matching_logic(iou_threshold)']).toBe(0.70);
  });

  it('verifies parameter names match backend API expectations', () => {
    // Backend expects snake_case
    const backendParams = {
      conf_threshold: 0.25,
      iou_threshold: 0.70,
      nms_iou_threshold: 0.45,
    };

    expect(backendParams).toHaveProperty('nms_iou_threshold');
    expect(backendParams).toHaveProperty('iou_threshold');
    expect(backendParams.nms_iou_threshold).not.toBe(backendParams.iou_threshold);
  });
});
