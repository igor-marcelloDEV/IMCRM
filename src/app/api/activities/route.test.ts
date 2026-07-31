import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskActivity } from '@/lib/tasks/types';

const mocks = vi.hoisted(() => ({
  requireEntitledAccount: vi.fn(),
  toErrorResponse: vi.fn(),
  listActivities: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireEntitledAccount: mocks.requireEntitledAccount,
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
  listActivities: mocks.listActivities,
}));

import { GET } from './route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const ACTIVITY = {
  id: '44444444-4444-4444-8444-444444444444',
  event_type: 'task.created',
  entity_type: 'task',
  entity_id: TASK_ID,
} as TaskActivity;
const context = {
  supabase: { name: 'rls-client' },
  accountId: 'account-1',
  userId: USER_ID,
  role: 'viewer',
  account: { id: 'account-1', name: 'Acme' },
  entitlement: { hasAccess: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEntitledAccount.mockResolvedValue(context);
  mocks.toErrorResponse.mockImplementation((error: unknown) => {
    const typed = error as { status?: number; message?: string };
    return Response.json(
      { error: typed.message ?? 'Erro interno do servidor' },
      { status: typed.status ?? 500 }
    );
  });
});

describe('/api/activities', () => {
  it('allows entitled viewers and applies bounded timeline filters', async () => {
    mocks.listActivities.mockResolvedValue({
      activities: [ACTIVITY],
      nextCursor: null,
    });
    const response = await GET(
      new Request(
        `http://localhost/api/activities?from=2026-07-29T03:00:00.000Z&to=2026-07-30T03:00:00.000Z&contact_id=${CONTACT_ID}&task_id=${TASK_ID}&limit=500`
      )
    );

    expect(mocks.requireEntitledAccount).toHaveBeenCalledOnce();
    expect(mocks.listActivities).toHaveBeenCalledWith(
      context.supabase,
      'account-1',
      expect.objectContaining({
        from: '2026-07-29T03:00:00.000Z',
        to: '2026-07-30T03:00:00.000Z',
        contactId: CONTACT_ID,
        taskId: TASK_ID,
        limit: 100,
      })
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      activities: [ACTIVITY],
    });
  });

  it('rejects incomplete entity filters before querying', async () => {
    const response = await GET(
      new Request(`http://localhost/api/activities?entity_id=${TASK_ID}`)
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.listActivities).not.toHaveBeenCalled();
  });
});
