import { describe, it, expect } from 'vitest';
import type { Task } from '@/hooks/use-tasks';
import { getTaskNavigationUrl } from '@/components/TasksPopover';

const baseTask = (overrides: Partial<Task>): Task => ({
  id: 1,
  name: 'Task',
  description: 'desc',
  task_type: 'training',
  status: 'running',
  progress: 50,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('getTaskNavigationUrl', () => {
  it('routes training tasks to models page with taskId', () => {
    const task = baseTask({ id: 42, task_type: 'yolo_training', project_id: 7 });
    expect(getTaskNavigationUrl(task)).toBe('/projects/7/models?taskId=42');
  });

  it('routes evaluation tasks to evaluations page with taskId', () => {
    const task = baseTask({ id: 5, task_type: 'model_evaluation', project_id: 3 });
    expect(getTaskNavigationUrl(task)).toBe('/projects/3/evaluations?taskId=5');
  });

  it('routes augmentation tasks to target dataset page when target_dataset_id is present', () => {
    const task = baseTask({
      id: 10,
      task_type: 'augmentation',
      project_id: 8,
      task_metadata: { target_dataset_id: 99 },
    });
    expect(getTaskNavigationUrl(task)).toBe('/projects/8/datasets/99');
  });

  it('falls back to datasets list for augmentation tasks when dataset id is missing', () => {
    const task = baseTask({ id: 11, task_type: 'augmentation', project_id: 8, task_metadata: {} });
    expect(getTaskNavigationUrl(task)).toBe('/projects/8/datasets');
  });

  it('uses task-level metadata project_id when task.project_id is absent', () => {
    const task = baseTask({
      id: 12,
      task_type: 'training',
      project_id: null,
      task_metadata: { project_id: 13 },
    });
    expect(getTaskNavigationUrl(task)).toBe('/projects/13/models?taskId=12');
  });

  it('returns null when no project id can be resolved', () => {
    const task = baseTask({ id: 13, task_type: 'training', project_id: null, task_metadata: {} });
    expect(getTaskNavigationUrl(task)).toBeNull();
  });
});
