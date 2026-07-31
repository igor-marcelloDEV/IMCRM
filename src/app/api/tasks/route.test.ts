import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/lib/tasks/types';

const mocks = vi.hoisted(() => ({
  requireEntitledAccount: vi.fn(),
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireEntitledAccount: mocks.requireEntitledAccount,
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
  listTasks: mocks.listTasks,
  createTask: mocks.createTask,
}));

import { GET, POST } from './route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TASK = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Retornar cliente',
  status: 'open',
} as Task;
const context = {
  supabase: { name: 'rls-client' },
  accountId: 'account-1',
  userId: USER_ID,
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
  entitlement: { hasAccess: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEntitledAccount.mockResolvedValue(context);
  mocks.requireRole.mockResolvedValue(context);
  mocks.toErrorResponse.mockImplementation((error: unknown) => {
    const typed = error as { status?: number; message?: string };
    return Response.json(
      { error: typed.message ?? 'Erro interno do servidor' },
      { status: typed.status ?? 500 }
    );
  });
});

describe('/api/tasks', () => {
  it('allows entitled viewers to list with an opaque next cursor', async () => {
    mocks.listTasks.mockResolvedValue({
      tasks: [TASK],
      nextCursor: 'opaque-next',
    });

    const response = await GET(
      new Request('http://localhost/api/tasks?status=open&assignee=mine')
    );

    expect(mocks.requireEntitledAccount).toHaveBeenCalledOnce();
    expect(mocks.listTasks).toHaveBeenCalledWith(
      context.supabase,
      'account-1',
      expect.objectContaining({
        statuses: ['open'],
        assignedTo: USER_ID,
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      tasks: [TASK],
      nextCursor: 'opaque-next',
    });
  });

  it('requires an agent and injects account/creator on create', async () => {
    mocks.createTask.mockResolvedValue(TASK);
    const response = await POST(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '  Retornar cliente ',
          priority: 'high',
        }),
      })
    );

    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.createTask).toHaveBeenCalledWith(context.supabase, {
      accountId: 'account-1',
      userId: USER_ID,
      mutation: {
        title: 'Retornar cliente',
        priority: 'high',
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ task: TASK });
  });

  it('rejects invalid JSON fields before calling the store', async () => {
    const response = await POST(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Tarefa', account_id: 'other' }),
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('keeps auth/entitlement failures private and no-store', async () => {
    const forbidden = Object.assign(new Error('Somente leitura'), {
      status: 403,
    });
    mocks.requireRole.mockRejectedValue(forbidden);

    const response = await POST(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'Bloqueada' }),
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
