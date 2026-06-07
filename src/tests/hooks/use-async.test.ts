import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAsync } from '@/hooks/use-async';

describe('useAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('initializes with default state', () => {
    const { result } = renderHook(() => useAsync());

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('initializes with custom loading state', () => {
    const { result } = renderHook(() => useAsync({ initialLoading: true }));

    expect(result.current.loading).toBe(true);
  });

  it('executes async function and updates state', async () => {
    const { result } = renderHook(() => useAsync<string>());

    const mockFn = vi.fn().mockResolvedValue('test data');

    await act(async () => {
      await result.current.execute(mockFn);
    });

    expect(result.current.data).toBe('test data');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('handles errors correctly', async () => {
    const { result } = renderHook(() => useAsync());

    const mockFn = vi.fn().mockRejectedValue(new Error('Test error'));

    await act(async () => {
      try {
        await result.current.execute(mockFn);
      } catch (err) {
        // Expected error
      }
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe('Test error');
  });

  it('calls onSuccess callback when operation succeeds', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAsync({ onSuccess }));

    const mockFn = vi.fn().mockResolvedValue('success data');

    await act(async () => {
      await result.current.execute(mockFn);
    });

    expect(onSuccess).toHaveBeenCalledWith('success data');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('calls onError callback when operation fails', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useAsync({ onError }));

    const testError = new Error('Test error');
    const mockFn = vi.fn().mockRejectedValue(testError);

    await act(async () => {
      try {
        await result.current.execute(mockFn);
      } catch (err) {
        // Expected error
      }
    });

    expect(onError).toHaveBeenCalledWith(testError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('resets state correctly', async () => {
    const { result } = renderHook(() => useAsync<string>());

    // Execute and get data
    await act(async () => {
      await result.current.execute(async () => 'test data');
    });

    expect(result.current.data).toBe('test data');

    // Reset
    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not update state after unmount', async () => {
    const { result, unmount } = renderHook(() => useAsync<string>());

    const mockFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('late data'), 100))
    );

    // Start async operation
    act(() => {
      result.current.execute(mockFn);
    });

    // Unmount before completion
    unmount();

    // Wait for async operation to complete
    await new Promise((resolve) => setTimeout(resolve, 150));

    // State should not have been updated (no error thrown)
  });

  it('sets data manually', () => {
    const { result } = renderHook(() => useAsync<string>());

    act(() => {
      result.current.setData('manual data');
    });

    expect(result.current.data).toBe('manual data');
  });

  it('sets error manually', () => {
    const { result } = renderHook(() => useAsync());

    act(() => {
      result.current.setError('manual error');
    });

    expect(result.current.error).toBe('manual error');
  });

  it('clears error on successful execution', async () => {
    const { result } = renderHook(() => useAsync<string>());

    // Set error manually
    act(() => {
      result.current.setError('initial error');
    });

    expect(result.current.error).toBe('initial error');

    // Execute successfully
    await act(async () => {
      await result.current.execute(async () => 'success');
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('success');
  });

  it('handles non-Error objects as errors', async () => {
    const { result } = renderHook(() => useAsync());

    const mockFn = vi.fn().mockRejectedValue('string error');

    await act(async () => {
      try {
        await result.current.execute(mockFn);
      } catch (err) {
        // Expected error
      }
    });

    expect(result.current.error).toBe('An error occurred');
  });

  it('executes with arguments', async () => {
    const { result } = renderHook(() => useAsync<string>());

    const mockFn = vi.fn().mockImplementation((a: number, b: number) => Promise.resolve(`${a + b}`));

    await act(async () => {
      await result.current.execute(mockFn, 5, 10);
    });

    expect(mockFn).toHaveBeenCalledWith(5, 10);
    expect(result.current.data).toBe('15');
  });
});
