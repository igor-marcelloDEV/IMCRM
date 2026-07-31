import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TaskApiError,
  cancelTask,
  createTask,
  listTaskActivities,
  listTasks,
  updateTask,
} from './client';
import type { Task } from './types';

const TASK = { id: 'task/1', title: 'Follow up' } as Task;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('task API client', () => {
  it('serializes list filters using the backend contract', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ tasks: [], nextCursor: 'next' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      listTasks({
        status: ['open', 'completed'],
        assignee: 'mine',
        contactId: 'contact-1',
        from: '2026-07-29T03:00:00.000Z',
        to: '2026-07-30T03:00:00.000Z',
        limit: 100,
      }),
    ).resolves.toEqual({ tasks: [], nextCursor: 'next' });

    const url = new URL(String(fetchMock.mock.calls[0][0]), 'https://crm.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'open,completed',
      assignee: 'mine',
      from: '2026-07-29T03:00:00.000Z',
      to: '2026-07-30T03:00:00.000Z',
      contact_id: 'contact-1',
      limit: '100',
    });
  });

  it('uses the expected mutation methods and URL-encodes task ids', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ task: TASK }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createTask({ title: 'Follow up' });
    await updateTask(TASK.id, { status: 'completed' });
    await cancelTask(TASK.id);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/tasks', 'POST'],
      ['/api/tasks/task%2F1', 'PATCH'],
      ['/api/tasks/task%2F1', 'DELETE'],
    ]);
  });

  it('serializes activity ranges and contact filters', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ activities: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listTaskActivities({
      from: 'from-iso',
      to: 'to-iso',
      contactId: 'contact-1',
      limit: 15,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/activities?from=from-iso&to=to-iso&contact_id=contact-1&limit=15',
    );
  });

  it('surfaces API errors with status and server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({ error: 'Read-only' }, { status: 403 }),
      ),
    );

    const failure = createTask({ title: 'Blocked' });
    await expect(failure).rejects.toEqual(
      expect.objectContaining<TaskApiError>({
        name: 'TaskApiError',
        message: 'Read-only',
        status: 403,
      }),
    );
  });
});

