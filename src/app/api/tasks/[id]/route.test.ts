import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/lib/tasks/types';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: mocks.toErrorResponse,
}));

vi.mock('@/lib/tasks/store', () => ({
  TaskStoreError: class TaskStoreError extends Error {
    constructor(
      message: string,
      readonly status = 500
    ) {
      super(message);
    }
  },
  updateTask: mocks.updateTask,
  cancelTask: mocks.cancelTask,
}));

import { DELETE, PATCH } from './route';

const TASK_ID = '22222222-2222-4222-8222-222222222222';
const TASK = {
  id: TASK_ID,
  title: 'Retornar cliente',
  status: 'completed',
} as Task;
const context = {
  supabase: { name: 'rls-client' },
  accountId: 'account-1',
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
};

function routeContext(id = TASK_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(context);
  mocks.toErrorResponse.mockImplementation((error: unknown) => {
    const typed = error as { status?: number; message?: string };
    return Response.json(
      { error: typed.message ?? 'Erro interno do servidor' },
      { status: typed.status ?? 500 }
    );
  });
});

describe('/api/tasks/[id]', () => {
  it('updates only the account-scoped task as agent+', async () => {
    mocks.updateTask.mockResolvedValue(TASK);
    const response = await PATCH(
      new Request(`http://localhost/api/tasks/${TASK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      }),
      routeContext()
    );

    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.updateTask).toHaveBeenCalledWith(context.supabase, {
      accountId: 'account-1',
      taskId: TASK_ID,
      mutation: { status: 'completed' },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ task: TASK });
  });

  it('soft-cancels through the store and returns the canceled task', async () => {
    const canceled = { ...TASK, status: 'canceled' } as Task;
    mocks.cancelTask.mockResolvedValue(canceled);

    const response = await DELETE(
      new Request(`http://localhost/api/tasks/${TASK_ID}`, {
        method: 'DELETE',
      }),
      routeContext()
    );

    expect(mocks.cancelTask).toHaveBeenCalledWith(
      context.supabase,
      'account-1',
      TASK_ID
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: canceled });
  });

  it('returns 404 without leaking whether another account owns the id', async () => {
    mocks.updateTask.mockResolvedValue(null);
    const response = await PATCH(
      new Request(`http://localhost/api/tasks/${TASK_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ priority: 'urgent' }),
      }),
      routeContext()
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects malformed task ids before mutation', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/tasks/not-a-uuid', {
        method: 'DELETE',
      }),
      routeContext('not-a-uuid')
    );

    expect(response.status).toBe(400);
    expect(mocks.cancelTask).not.toHaveBeenCalled();
  });
});
