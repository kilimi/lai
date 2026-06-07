/**
 * Component tests for ThresholdExplorer
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ThresholdExplorer, RawPrediction, RawGTBox } from '../../components/ThresholdExplorer';
import '@testing-library/jest-dom';

// Mock the Slider component
vi.mock('@/components/ui/slider', () => ({
  Slider: ({ value, onValueChange }: any) => (
    <input
      type="range"
      data-testid="slider"
      value={value[0]}
      onChange={(e) => onValueChange([parseFloat(e.target.value)])}
      min={0}
      max={1}
      step={0.01}
    />
  ),
}));

// Mock the ConfusionMatrixCellModal
vi.mock('@/components/ConfusionMatrixCellModal', () => ({
  ConfusionMatrixCellModal: ({ open, onOpenChange }: any) =>
    open ? <div data-testid="cm-modal">CM Modal</div> : null,
}));

describe('ThresholdExplorer Component', () => {
  const mockPredictions: RawPrediction[] = [
    { image_id: 1, class_id: 0, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
    { image_id: 1, class_id: 1, bbox_xyxy: [30, 30, 40, 40], conf: 0.8 },
  ];

  const mockGroundTruth: RawGTBox[] = [
    { image_id: 1, file_name: 'image1.jpg', class_id: 0, bbox: [10, 10, 20, 20], class_name: 'cat' },
    { image_id: 1, file_name: 'image1.jpg', class_id: 1, bbox: [30, 30, 40, 40], class_name: 'dog' },
  ];

  const mockClassNames = ['cat', 'dog', 'background'];
  const mockImageIdToFilename = { '1': 'image1.jpg' };

  const defaultProps = {
    predictions: mockPredictions,
    groundTruth: mockGroundTruth,
    classNames: mockClassNames,
    imageIdToFilename: mockImageIdToFilename,
    projectId: 1,
    datasetId: 1,
    initialConf: 0.5,
    initialIou: 0.5,
    taskId: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  afterEach(() => {
    // Ensure timers are cleaned up after each test
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render without crashing', () => {
      render(<ThresholdExplorer {...defaultProps} />);
      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should display initial metrics', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByText(/Precision/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Recall/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/F1/i).length).toBeGreaterThan(0);
      });
    });

    it('should show modified badge when thresholds change', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      const sliders = screen.getAllByTestId('slider');
      const confSlider = sliders[0];

      act(() => {
        fireEvent.change(confSlider, { target: { value: '0.7' } });
      });

      await waitFor(() => {
        expect(screen.getByText('modified')).toBeInTheDocument();
      });
    });

    it('should not show modified badge initially', () => {
      render(<ThresholdExplorer {...defaultProps} />);
      expect(screen.queryByText('modified')).not.toBeInTheDocument();
    });

    it('should show helper explanations for confidence and IoU thresholds', () => {
      render(<ThresholdExplorer {...defaultProps} />);

      expect(screen.getByText(/Minimum model confidence required to keep a prediction/i)).toBeInTheDocument();
      expect(screen.getByText(/Minimum overlap needed to match a prediction with ground truth/i)).toBeInTheDocument();
    });
  });

  describe('dataset navigation', () => {
    it('should open test dataset in a new tab when redirect button is clicked', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      render(<ThresholdExplorer {...defaultProps} projectId={3} datasetId={9} />);

      fireEvent.click(screen.getByRole('button', { name: /open test dataset/i }));

      expect(openSpy).toHaveBeenCalledWith('/projects/3/datasets/9', '_blank', 'noopener,noreferrer');
      openSpy.mockRestore();
    });
  });

  describe('threshold adjustments', () => {
    it('should update confidence threshold', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      const sliders = screen.getAllByTestId('slider');
      const confSlider = sliders[0];

      act(() => {
        fireEvent.change(confSlider, { target: { value: '0.7' } });
      });

      await waitFor(() => {
        expect(confSlider).toHaveValue('0.7');
      });
    });

    it('should update IoU threshold', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      const sliders = screen.getAllByTestId('slider');
      const iouSlider = sliders[1];

      act(() => {
        fireEvent.change(iouSlider, { target: { value: '0.6' } });
      });

      await waitFor(() => {
        expect(iouSlider).toHaveValue('0.6');
      });
    });

    it('should recompute metrics after threshold change with debounce', async () => {
      vi.useFakeTimers();
      render(<ThresholdExplorer {...defaultProps} />);

      const sliders = screen.getAllByTestId('slider');
      const confSlider = sliders[0];

      act(() => {
        fireEvent.change(confSlider, { target: { value: '0.9' } });
      });

      // Fast forward past debounce delay
      act(() => {
        vi.advanceTimersByTime(120);
      });

      // Flush all pending promises
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Metrics should be recomputed - verify by checking that precision metrics exist
      const precisionElements = screen.getAllByText(/Precision/i);
      expect(precisionElements.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });

  describe('save functionality', () => {
    it('should call API when save button is clicked', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/tasks/1/eval-thresholds'),
          expect.objectContaining({
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });
    });

    it('should show success state after successful save', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /thresholds saved/i })).toBeInTheDocument();
      });
    });

    it('should show error message on save failure', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      });

      render(<ThresholdExplorer {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to save/i)).toBeInTheDocument();
        expect(screen.getByText(/Server error/i)).toBeInTheDocument();
      });
    });

    it('should handle network error gracefully', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      render(<ThresholdExplorer {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to save/i)).toBeInTheDocument();
      });
    });

    it('should call onSaved callback after successful save', async () => {
      const onSaved = vi.fn();
      render(<ThresholdExplorer {...defaultProps} onSaved={onSaved} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(onSaved).toHaveBeenCalled();
      });
    });

    it('should not call onSaved callback on save failure', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      });

      const onSaved = vi.fn();
      render(<ThresholdExplorer {...defaultProps} onSaved={onSaved} />);

      const saveButton = screen.getByRole('button', { name: /save thresholds/i });
      
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Failed to save/i)).toBeInTheDocument();
      });

      expect(onSaved).not.toHaveBeenCalled();
    });

    it('should save dataset predictions with default all-selection mode', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      global.fetch = fetchMock;

      render(<ThresholdExplorer {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /save predictions to dataset/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save predictions$/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /save predictions$/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/predictions/evaluation/1/save-to-dataset'),
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: expect.stringContaining('"save_selection":"all"'),
          })
        );
      });
    });

    it('should send cm_cells selection when picking confusion matrix cells', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      global.fetch = fetchMock;

      render(<ThresholdExplorer {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /save predictions to dataset/i }));
      await waitFor(() => {
        expect(screen.getByText(/Pick cells from the confusion matrix/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Pick cells from the confusion matrix/i));

      // Use a quick-selector to choose diagonal cells
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /TP diagonal/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /TP diagonal/i }));

      fireEvent.click(screen.getByRole('button', { name: /^Save \d+ prediction/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/predictions/evaluation/1/save-to-dataset'),
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"save_selection":"cm_cells"'),
          })
        );
      });
    });

    it('should surface backend detail when saving selected cells fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'No predictions fall into the selected confusion-matrix cells at current thresholds.' }),
      });

      render(<ThresholdExplorer {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /save predictions to dataset/i }));
      await waitFor(() => {
        expect(screen.getByText(/Pick cells from the confusion matrix/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Pick cells from the confusion matrix/i));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /TP diagonal/i })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('button', { name: /TP diagonal/i }));
      fireEvent.click(screen.getByRole('button', { name: /^Save \d+ prediction/i }));

      await waitFor(() => {
        expect(screen.getByText(/No predictions fall into the selected confusion-matrix cells at current thresholds\./i)).toBeInTheDocument();
      });
    });
  });

  describe('per-class confidence', () => {
    it('should handle initialPerClassConf prop', () => {
      const initialPerClassConf = { cat: 0.7, dog: 0.6 };
      render(<ThresholdExplorer {...defaultProps} initialPerClassConf={initialPerClassConf} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should handle initialPerClassConf with invalid class names', () => {
      const initialPerClassConf = { invalidClass: 0.7 };
      
      // Should not crash
      render(<ThresholdExplorer {...defaultProps} initialPerClassConf={initialPerClassConf} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should handle initialPerClassConf with out-of-bounds indices', () => {
      const classNames = ['cat', 'dog', 'background'];
      const initialPerClassConf = { cat: 0.7, dog: 0.6, extraClass: 0.5 };
      
      // Should not crash
      render(<ThresholdExplorer {...defaultProps} initialPerClassConf={initialPerClassConf} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });
  });

  describe('cleanup and memory management', () => {
    it('should cleanup timer on unmount', () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      
      const { unmount } = render(<ThresholdExplorer {...defaultProps} />);

      // Change threshold to start timer
      const sliders = screen.getAllByTestId('slider');
      act(() => {
        fireEvent.change(sliders[0], { target: { value: '0.7' } });
      });

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should not update state after unmount', async () => {
      vi.useFakeTimers();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const { unmount } = render(<ThresholdExplorer {...defaultProps} />);

      // Change threshold to trigger debounced update
      const sliders = screen.getAllByTestId('slider');
      act(() => {
        fireEvent.change(sliders[0], { target: { value: '0.7' } });
      });

      unmount();

      // Advance time past debounce
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Should not cause React warning about updating unmounted component
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Can't perform a React state update on an unmounted component")
      );

      consoleError.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('edge cases', () => {
    it('should handle empty predictions', () => {
      render(<ThresholdExplorer {...defaultProps} predictions={[]} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should handle empty ground truth', () => {
      render(<ThresholdExplorer {...defaultProps} groundTruth={[]} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should handle both empty predictions and ground truth', () => {
      render(<ThresholdExplorer {...defaultProps} predictions={[]} groundTruth={[]} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
    });

    it('should handle invalid class IDs in predictions', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const invalidPredictions: RawPrediction[] = [
        { image_id: 1, class_id: 999, bbox_xyxy: [10, 10, 20, 20], conf: 0.9 },
      ];

      render(<ThresholdExplorer {...defaultProps} predictions={invalidPredictions} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
      
      consoleWarn.mockRestore();
    });

    it('should handle invalid class IDs in ground truth', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const invalidGroundTruth: RawGTBox[] = [
        { image_id: 1, file_name: 'image1.jpg', class_id: 999, bbox: [10, 10, 20, 20], class_name: 'invalid' },
      ];

      render(<ThresholdExplorer {...defaultProps} groundTruth={invalidGroundTruth} />);

      expect(screen.getByText('Threshold Explorer')).toBeInTheDocument();
      
      consoleWarn.mockRestore();
    });
  });

  describe('confusion matrix interaction', () => {
    it('should render confusion matrix section', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      // Wait for metrics to compute
      await waitFor(() => {
        expect(screen.getAllByText(/Precision/i).length).toBeGreaterThan(0);
      }, { timeout: 5000 });

      // Verify confusion matrix heading is present
      expect(screen.getByText(/Confusion Matrix/i)).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('should reset to initial values when reset button is clicked', async () => {
      render(<ThresholdExplorer {...defaultProps} />);

      // Change thresholds
      const sliders = screen.getAllByTestId('slider');
      act(() => {
        fireEvent.change(sliders[0], { target: { value: '0.9' } });
      });

      await waitFor(() => {
        expect(screen.getByText('modified')).toBeInTheDocument();
      });

      // Find and click reset button
      const resetButton = screen.getByText(/Reset to evaluation defaults/i);
      act(() => {
        fireEvent.click(resetButton);
      });

      await waitFor(() => {
        expect(screen.queryByText('modified')).not.toBeInTheDocument();
      });

      // Sliders should be back to initial values
      expect(sliders[0]).toHaveValue('0.5');
      expect(sliders[1]).toHaveValue('0.5');
    });
  });
});
