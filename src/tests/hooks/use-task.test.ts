import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTask, type Task } from '@/hooks/use-task';

// Mock useApi hook
vi.mock('@/hooks/use-api', () => ({
  useApi: () => ({ api: mockApi }),
}));

const mockApi = {
  getTask: vi.fn(),
};

const mockTask: Task = {
  id: 123,
  name: 'Test Task',
  status: 'completed',
  progress: 100,
  created_at: '2024-01-01T00:00:00Z',
  task_metadata: {},
};

describe('useTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // NOTE: vi.useFakeTimers() is NOT set globally here.
    // Non-polling tests use real timers + waitFor.
    // Polling tests call vi.useFakeTimers() themselves.

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: mockTask,
    });
  });

  afterEach(() => {
    vi.useRealTimers(); // safe no-op if real timers were already active
  });

  // ── Non-polling tests: real timers + waitFor ───────────────────────────────

  it('fetches task on mount', async () => {
    const { result } = renderHook(() => useTask(123));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.task).toEqual(mockTask);
    expect(mockApi.getTask).toHaveBeenCalledWith(123);
  });

  it('does not fetch when taskId is null', () => {
    const { result } = renderHook(() => useTask(null));

    expect(result.current.loading).toBe(false);
    expect(result.current.task).toBeNull();
    expect(mockApi.getTask).not.toHaveBeenCalled();
  });

  // ── Polling tests: fake timers + advanceTimersByTimeAsync ───────────────────
  // advanceTimersByTimeAsync(ms) advances the clock by exactly ms and flushes
  // pending Promises between steps. runAllTimersAsync() must NOT be used with
  // setInterval because it repeats until the queue is empty → fires hundreds of times.

  it('starts polling for running tasks', async () => {
    vi.useFakeTimers();

    const runningTask: Task = { ...mockTask, status: 'running', progress: 50 };
    mockApi.getTask.mockResolvedValue({
      success: true,
      data: runningTask,
    });

    const { result } = renderHook(() => useTask(123, { poll: true, pollInterval: 1000 }));

    // Flush initial fetch (Promise microtasks resolve even under fake timers)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(1);

    // First interval tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(2);

    // Second interval tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(3);
  });

  it('stops polling when task completes', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    mockApi.getTask.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true,
        data: callCount < 3 ? { ...mockTask, status: 'running' } : mockTask,
      });
    });

    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useTask(123, { poll: true, pollInterval: 1000, onComplete })
    );

    // Initial fetch → running (callCount=1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.task?.status).toBe('running');

    // Poll 1 → still running (callCount=2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.task?.status).toBe('running');

    // Poll 2 → completed (callCount=3), interval cleared
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.task?.status).toBe('completed');
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    const callsAtCompletion = mockApi.getTask.mock.calls.length;

    // No more polling after completion
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(callsAtCompletion);
  });

  it('calls onError callback when task fails', async () => {
    vi.useFakeTimers();
    const runningTask: Task = { ...mockTask, status: 'running', progress: 50 };
    const failedTask: Task = { ...mockTask, status: 'failed', error_message: 'Task failed' };
    mockApi.getTask
      .mockResolvedValueOnce({
        success: true,
        data: runningTask,
      })
      .mockResolvedValueOnce({
        success: true,
        data: failedTask,
      });

    const onError = vi.fn();
    const { result } = renderHook(() =>
      useTask(123, { poll: true, pollInterval: 1000, onError })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.task?.status).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.task?.status).toBe('failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('stops polling after max duration', async () => {
    vi.useFakeTimers();

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: { ...mockTask, status: 'running' },
    });

    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useTask(123, {
        poll: true,
        pollInterval: 1000,
        maxPollDuration: 5000,
        onTimeout,
      })
    );

    // Initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.task?.status).toBe('running');

    // Advance past max duration in one step
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(onTimeout).toHaveBeenCalled();
  });

  it('cleans up polling on unmount', async () => {
    vi.useFakeTimers();

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: { ...mockTask, status: 'running' },
    });

    const { result, unmount } = renderHook(() => useTask(123, { poll: true, pollInterval: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsBeforeUnmount = mockApi.getTask.mock.calls.length;

    unmount();

    // Advance time — no new calls should be made
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it('refetches task when refetch is called', async () => {
    const { result } = renderHook(() => useTask(123));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockApi.getTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(mockApi.getTask).toHaveBeenCalledTimes(2));
  });

  it('handles API errors gracefully', async () => {
    mockApi.getTask.mockResolvedValue({
      success: false,
      error: 'API error',
    });

    const { result } = renderHook(() => useTask(123));

    await waitFor(() => {
      expect(result.current.error).toBe('API error');
    });

    expect(result.current.loading).toBe(false);
  });

  it('resets state when taskId changes', async () => {
    const { result, rerender } = renderHook(
      ({ taskId }) => useTask(taskId),
      { initialProps: { taskId: 123 } }
    );

    await waitFor(() => expect(result.current.task?.id).toBe(123));

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: { ...mockTask, id: 456 },
    });

    rerender({ taskId: 456 });

    await waitFor(() => {
      expect(result.current.task?.id).toBe(456);
    });

    expect(mockApi.getTask).toHaveBeenCalledWith(456);
  });

  it('does not poll for completed tasks', async () => {
    vi.useFakeTimers();

    mockApi.getTask.mockResolvedValue({
      success: true,
      data: mockTask, // status: completed
    });

    renderHook(() => useTask(123, { poll: true, pollInterval: 1000 }));

    // Flush initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(1);

    // Advance time — no additional calls since task is already completed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mockApi.getTask).toHaveBeenCalledTimes(1);
  });
});
