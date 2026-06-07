import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '@/hooks/use-tasks';

const mockApi = {
  getActiveTasks: vi.fn(),
  getTasks: vi.fn(),
  cancelTask: vi.fn(),
};

vi.mock('@/hooks/use-api', () => ({
  useApi: () => ({ api: mockApi, isConfigured: true }),
}));

vi.mock('@/contexts/ExportContext', () => ({
  useExport: () => ({ isExporting: false }),
}));

describe('useTasks cancel flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockApi.getActiveTasks.mockResolvedValue({
      success: true,
      data: [],
    });

    mockApi.getTasks.mockResolvedValue({
      success: true,
      data: [],
    });
  });

  it('refreshes active and full task lists after successful cancel', async () => {
    mockApi.cancelTask.mockResolvedValue({ success: true });

    const { result } = renderHook(() => useTasks(2));

    await waitFor(() => {
      expect(mockApi.getActiveTasks).toHaveBeenCalled();
      expect(mockApi.getTasks).toHaveBeenCalled();
    });

    const activeCallsBefore = mockApi.getActiveTasks.mock.calls.length;
    const allCallsBefore = mockApi.getTasks.mock.calls.length;

    await act(async () => {
      const ok = await result.current.cancelTask(123);
      expect(ok).toBe(true);
    });

    expect(mockApi.cancelTask).toHaveBeenCalledWith(123);
    expect(mockApi.getActiveTasks.mock.calls.length).toBe(activeCallsBefore + 1);
    expect(mockApi.getTasks.mock.calls.length).toBe(allCallsBefore + 1);
  });

  it('returns false and does not refresh lists when cancel fails', async () => {
    mockApi.cancelTask.mockResolvedValue({ success: false, error: 'cancel failed' });

    const { result } = renderHook(() => useTasks(2));

    await waitFor(() => {
      expect(mockApi.getActiveTasks).toHaveBeenCalled();
      expect(mockApi.getTasks).toHaveBeenCalled();
    });

    const activeCallsBefore = mockApi.getActiveTasks.mock.calls.length;
    const allCallsBefore = mockApi.getTasks.mock.calls.length;

    await act(async () => {
      const ok = await result.current.cancelTask(456);
      expect(ok).toBe(false);
    });

    expect(mockApi.cancelTask).toHaveBeenCalledWith(456);
    expect(mockApi.getActiveTasks.mock.calls.length).toBe(activeCallsBefore);
    expect(mockApi.getTasks.mock.calls.length).toBe(allCallsBefore);
  });
});
