import type {
  Task,
  TaskActivity,
  TaskDraft,
  TaskStatus,
} from '@/lib/tasks/types';

export class TaskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TaskApiError';
  }
}

async function requestJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    cache: 'no-store',
    ...init,
    headers: init?.body
      ? { 'Content-Type': 'application/json', ...init.headers }
      : init?.headers,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new TaskApiError(
      payload.error || `Request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

export interface ListTasksOptions {
  status?: TaskStatus[];
  assignee?: 'mine' | 'all' | 'unassigned' | string;
  from?: string;
  to?: string;
  contactId?: string;
  dealId?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export async function listTasks(
  options: ListTasksOptions = {},
): Promise<{ tasks: Task[]; nextCursor?: string }> {
  const query = new URLSearchParams();
  if (options.status?.length) query.set('status', options.status.join(','));
  if (options.assignee) query.set('assignee', options.assignee);
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  if (options.contactId) query.set('contact_id', options.contactId);
  if (options.dealId) query.set('deal_id', options.dealId);
  if (options.limit) query.set('limit', String(options.limit));
  if (options.cursor) query.set('cursor', options.cursor);

  const suffix = query.size ? `?${query.toString()}` : '';
  return requestJson(`/api/tasks${suffix}`, { signal: options.signal });
}

export async function createTask(draft: TaskDraft): Promise<Task> {
  const payload = await requestJson<{ task: Task }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
  return payload.task;
}

export async function updateTask(
  taskId: string,
  patch: Partial<TaskDraft>,
): Promise<Task> {
  const payload = await requestJson<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
  return payload.task;
}

export async function cancelTask(taskId: string): Promise<Task> {
  const payload = await requestJson<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' },
  );
  return payload.task;
}

export interface ListActivitiesOptions {
  from?: string;
  to?: string;
  contactId?: string;
  taskId?: string;
  limit?: number;
  signal?: AbortSignal;
}

export async function listTaskActivities(
  options: ListActivitiesOptions = {},
): Promise<{ activities: TaskActivity[]; nextCursor?: string }> {
  const query = new URLSearchParams();
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  if (options.contactId) query.set('contact_id', options.contactId);
  if (options.taskId) query.set('task_id', options.taskId);
  if (options.limit) query.set('limit', String(options.limit));

  const suffix = query.size ? `?${query.toString()}` : '';
  return requestJson(`/api/activities${suffix}`, { signal: options.signal });
}

