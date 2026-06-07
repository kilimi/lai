import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ConfusionMatrixCellModal, CmSample } from '../../components/ConfusionMatrixCellModal';
import * as apiConfig from '@/config/api';

// Mock API config
vi.mock('@/config/api', () => ({
  getApiBaseUrl: vi.fn(() => 'http://localhost:9999'),
}));

// Mock Dialog component (from Radix UI)
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children, className }: any) => (
    <div data-testid="dialog-content" className={className}>{children}</div>
  ),
  DialogTitle: ({ children, className }: any) => (
    <h2 data-testid="dialog-title" className={className}>{children}</h2>
  ),
}));

describe('ConfusionMatrixCellModal', () => {
  let getApiBaseUrlMock: ReturnType<typeof vi.fn>;

  const mockSamples: CmSample[] = [
    {
      image_id: 1,
      file_name: 'img_001.jpg',
      gt_bbox: [100, 100, 200, 200],
      gt_class_name: 'cat',
      pred_bbox: [105, 105, 205, 205],
      pred_class_name: 'cat',
      conf: 0.95,
      iou: 0.85,
    },
    {
      image_id: 2,
      file_name: 'img_002.jpg',
      gt_bbox: [50, 50, 150, 150],
      gt_class_name: 'dog',
      pred_bbox: [55, 55, 155, 155],
      pred_class_name: 'dog',
      conf: 0.88,
      iou: 0.75,
    },
  ];

  beforeEach(() => {
    getApiBaseUrlMock = vi.mocked(apiConfig.getApiBaseUrl);
    getApiBaseUrlMock.mockReturnValue('http://localhost:9999');
    
    // Mock HTMLCanvasElement getContext
    const mockGetContext = vi.fn().mockReturnValue({
      scale: vi.fn(),
      clearRect: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 100 }),
    });
    HTMLCanvasElement.prototype.getContext = mockGetContext as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering and display', () => {
    it('should render modal when open', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('dialog')).toBeInTheDocument();
      expect(screen.getByTestId('dialog-content')).toBeInTheDocument();
    });

    it('should not render modal when closed', () => {
      render(
        <ConfusionMatrixCellModal
          open={false}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
    });

    it('should show True Positive title for matching classes', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('cm-modal-visible-heading')).toHaveTextContent(/True Positives — cat/i);
    });

    it('should show False Positive title when rowClass is background', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="background"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('cm-modal-visible-heading')).toHaveTextContent(/False Positives/i);
      expect(screen.getByText(/Model predicted "cat"/i)).toBeInTheDocument();
    });

    it('should show False Negative title when colClass is background', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="dog"
          colClass="background"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('cm-modal-visible-heading')).toHaveTextContent(/False Negatives/i);
      expect(screen.getByText(/GT "dog" exists but model missed it/i)).toBeInTheDocument();
    });

    it('should show Confusion title for mismatched classes', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="dog"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('cm-modal-visible-heading')).toHaveTextContent(/Confusion/i);
      expect(screen.getByText(/Actual: "cat", predicted: "dog"/i)).toBeInTheDocument();
    });

    it('should display sample count and total', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={10}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText(/Showing 2 of 10/i)).toBeInTheDocument();
    });

    it('should show empty state when no samples', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={[]}
          rowClass="cat"
          colClass="cat"
          count={0}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText(/No samples available/i)).toBeInTheDocument();
    });
  });

  describe('Grid view', () => {
    it('should render grid of image cards', () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Should render images for each sample
      const images = container.querySelectorAll('img');
      expect(images.length).toBeGreaterThanOrEqual(2);
    });

    it('should display filenames in grid', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText('img_001.jpg')).toBeInTheDocument();
      expect(screen.getByText('img_002.jpg')).toBeInTheDocument();
    });

    it('should display IoU values when available', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText(/IoU 0.85/i)).toBeInTheDocument();
      expect(screen.getByText(/IoU 0.75/i)).toBeInTheDocument();
    });

    it('should show legend with GT and Prediction colors', () => {
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText(/GT box/i)).toBeInTheDocument();
      expect(screen.getByText(/Prediction/i)).toBeInTheDocument();
    });
  });

  describe('Detail view navigation', () => {
    it('should open detail view when clicking image card', async () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Find and click first image card
      const imageCards = container.querySelectorAll('[role="button"]');
      expect(imageCards.length).toBeGreaterThan(0);
      
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      // Should show detail view with navigation
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Back to grid/i })).toBeInTheDocument();
      });
    });

    it('should show current index and total in detail view', async () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Click first card
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      await waitFor(() => {
        expect(screen.getByText('1 / 2')).toBeInTheDocument();
      });
    });

    it('should navigate to next image with next button', async () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Open detail view
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      // Click next button
      await waitFor(() => {
        expect(screen.getByText('1 / 2')).toBeInTheDocument();
      });

      const nextButton = screen.getByRole('button', { name: /Next image/i });
      await act(async () => {
        fireEvent.click(nextButton);
      });

      await waitFor(() => {
        expect(screen.getByText('2 / 2')).toBeInTheDocument();
      });
    });

    it('should return to grid when clicking back button', async () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Open detail view
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      // Click back button
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Back to grid/i })).toBeInTheDocument();
      });

      const backButton = screen.getByRole('button', { name: /Back to grid/i });
      await act(async () => {
        fireEvent.click(backButton);
      });

      // Should return to grid view
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Back to grid/i })).not.toBeInTheDocument();
        expect(screen.getByText('img_001.jpg')).toBeInTheDocument();
      });
    });
  });

  describe('Keyboard navigation', () => {
    it('should close detail view with Escape key', async () => {
      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Open detail view
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      await waitFor(() => {
        const backButtons = screen.getAllByText(/Back to grid/i);
        expect(backButtons.length).toBeGreaterThan(0);
      });

      // Press Escape
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });

      // Should return to grid (button should be gone, only grid legend remains)
      await waitFor(() => {
        // Grid view has filenames visible
        expect(screen.getByText('img_001.jpg')).toBeInTheDocument();
      });
    });

    it('should not handle keyboard events when typing in input', async () => {
      const { container } = render(
        <>
          <input data-testid="test-input" />
          <ConfusionMatrixCellModal
            open={true}
            onOpenChange={() => {}}
            samples={mockSamples}
            rowClass="cat"
            colClass="cat"
            count={2}
            projectId={1}
            datasetId={1}
            taskId={1}
          />
        </>
      );

      // Open detail view
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Back to grid/i })).toBeInTheDocument();
      });

      // Focus input and press Escape
      const input = screen.getByTestId('test-input');
      input.focus();
      
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape', target: input });
      });

      // Should still be in detail view (ignored because input was focused)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Back to grid/i })).toBeInTheDocument();
      });
    });
  });

  describe('Image URL handling', () => {
    it('should generate URLs with evaluation endpoint when imageId exists', () => {
      const samples: CmSample[] = [
        {
          image_id: 123,
          file_name: 'test.jpg',
          gt_bbox: [100, 100, 200, 200],
        },
      ];

      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={5}
          datasetId={10}
          taskId={42}
        />
      );

      const img = container.querySelector('img');
      expect(img?.src).toContain('/evaluation-image/42/123');
    });

    it('should use fallback URLs when imageId missing', () => {
      const samples: CmSample[] = [
        {
          file_name: 'test.jpg',
          gt_bbox: [100, 100, 200, 200],
        },
      ];

      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={5}
          datasetId={10}
          taskId={42}
        />
      );

      const img = container.querySelector('img');
      // Should use project URL as fallback
      expect(img?.src).toContain('/projects/5/10/images/test.jpg');
    });

    it('should map filename to imageId from imageIdToFilename prop', async () => {
      const samples: CmSample[] = [
        {
          file_name: 'mapped_image.jpg',
          gt_bbox: [100, 100, 200, 200],
        },
      ];

      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={5}
          datasetId={10}
          taskId={42}
          imageIdToFilename={{ '999': 'mapped_image.jpg' }}
        />
      );

      // Wait for useEffect to process mapping
      await waitFor(() => {
        const img = container.querySelector('img');
        expect(img?.src).toContain('/evaluation-image/42/999');
      });
    });
  });

  describe('Image error handling', () => {
    it('should reduce opacity when all image URLs fail', async () => {
      const samples: CmSample[] = [
        {
          file_name: 'nonexistent.jpg',
          gt_bbox: [100, 100, 200, 200],
        },
      ];

      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={5}
          datasetId={10}
          taskId={42}
        />
      );

      let img = container.querySelector('img') as HTMLImageElement;
      expect(img).toBeInTheDocument();

      // Simulate first URL failing
      await act(async () => {
        fireEvent.error(img);
      });

      // Wait for src to change (fallback URL)
      await waitFor(() => {
        img = container.querySelector('img') as HTMLImageElement;
        expect(img.src).toContain('/static/data/images/');
      });

      // Simulate second URL failing  
      await act(async () => {
        fireEvent.error(img);
      });

      // After all URLs fail, opacity should be 0.3
      await waitFor(() => {
        img = container.querySelector('img') as HTMLImageElement;
        expect(img.style.opacity).toBe('0.3');
      });
    });
  });

  describe('Modal state management', () => {
    it('should call onOpenChange when modal state changes', () => {
      const onOpenChange = vi.fn();

      const { rerender } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={onOpenChange}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByTestId('dialog')).toBeInTheDocument();

      // Close modal
      rerender(
        <ConfusionMatrixCellModal
          open={false}
          onOpenChange={onOpenChange}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
    });

    it('should reset to grid view when modal closes', async () => {
      const { container, rerender } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Open detail view
      const imageCards = container.querySelectorAll('[role="button"]');
      await act(async () => {
        fireEvent.click(imageCards[0]);
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Back to grid/i })).toBeInTheDocument();
      });

      // Close modal
      rerender(
        <ConfusionMatrixCellModal
          open={false}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Reopen modal - should be back to grid view
      rerender(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={mockSamples}
          rowClass="cat"
          colClass="cat"
          count={2}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      await waitFor(() => {
        // Should be back in grid view with filenames visible
        expect(screen.getByText('img_001.jpg')).toBeInTheDocument();
        // Detail view elements should be minimal
        expect(screen.queryByText('1 / 2')).not.toBeInTheDocument();
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle single sample', () => {
      const singleSample = [mockSamples[0]];
      
      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={singleSample}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText(/Showing 1 of 1/i)).toBeInTheDocument();
      expect(screen.getByText('img_001.jpg')).toBeInTheDocument();
    });

    it('should handle samples without bboxes', () => {
      const samples: CmSample[] = [
        {
          file_name: 'no_bbox.jpg',
        },
      ];

      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText('no_bbox.jpg')).toBeInTheDocument();
    });

    it('should handle samples without IoU', () => {
      const samples: CmSample[] = [
        {
          file_name: 'no_iou.jpg',
          gt_bbox: [100, 100, 200, 200],
          pred_bbox: [100, 100, 200, 200],
        },
      ];

      const { container } = render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      // Should not show IoU text
      expect(container.textContent).not.toContain('IoU');
    });

    it('should handle samples without confidence', () => {
      const samples: CmSample[] = [
        {
          file_name: 'no_conf.jpg',
          pred_bbox: [100, 100, 200, 200],
          pred_class_name: 'cat',
        },
      ];

      render(
        <ConfusionMatrixCellModal
          open={true}
          onOpenChange={() => {}}
          samples={samples}
          rowClass="cat"
          colClass="cat"
          count={1}
          projectId={1}
          datasetId={1}
          taskId={1}
        />
      );

      expect(screen.getByText('no_conf.jpg')).toBeInTheDocument();
    });
  });
});
