import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { TaskListFilters } from './contracts';
import { cancelTask, listTasks } from './store';

interface Result {
  data: unknown;
  error: unknown;
}

class QueryBuilder implements PromiseLike<Result> {
  readonly select = vi.fn(() => this);
  readonly insert = vi.fn(() => this);
  readonly update = vi.fn(() => this);
  readonly delete = vi.fn(() => this);
  readonly eq = vi.fn(() => this);
  readonly in = vi.fn(() => this);
  readonly is = vi.fn(() => this);
  readonly gte = vi.fn(() => this);
  readonly lt = vi.fn(() => this);
  readonly order = vi.fn(() => this);
  readonly limit = vi.fn(() => this);
  readonly or = vi.fn(() => this);

  constructor(private readonly result: Result) {}

  maybeSingle = vi.fn(async () => this.result);

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

const TASK_ROW = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Retornar cliente',
  description: null,
  status: 'open',
  priority: 'normal',
  due_at: null,
  completed_at: null,
  assigned_to: null,
  created_by: null,
  contact_id: null,
  deal_id: null,
  order_id: null,
  conversation_id: null,
  created_at: '2026-07-29T12:00:00.000Z',
  updated_at: '2026-07-29T12:00:00.000Z',
};

describe('task store', () => {
  it('implements DELETE semantics as an account-scoped canceled update', async () => {
    const tasks = new QueryBuilder({
      data: { ...TASK_ROW, status: 'canceled' },
      error: null,
    });
    const from = vi.fn(() => tasks);
    const db = { from } as unknown as SupabaseClient;

    await expect(
      cancelTask(db, 'account-1', TASK_ROW.id)
    ).resolves.toMatchObject({
      id: TASK_ROW.id,
      status: 'canceled',
    });

    expect(tasks.update).toHaveBeenCalledWith({ status: 'canceled' });
    expect(tasks.eq).toHaveBeenCalledWith('id', TASK_ROW.id);
    expect(tasks.eq).toHaveBeenCalledWith('account_id', 'account-1');
    expect(tasks.delete).not.toHaveBeenCalled();
  });

  it('scopes list queries and caps each page to limit plus one', async () => {
    const tasks = new QueryBuilder({ data: [TASK_ROW], error: null });
    const from = vi.fn(() => tasks);
    const db = { from } as unknown as SupabaseClient;
    const filters: TaskListFilters = {
      limit: 100,
      cursor: null,
      statuses: ['open'],
      priorities: null,
      assignedTo: '11111111-1111-4111-8111-111111111111',
      unassigned: false,
      from: '2026-07-29T03:00:00.000Z',
      to: '2026-07-30T03:00:00.000Z',
      contactId: null,
      dealId: null,
      orderId: null,
      conversationId: null,
    };

    const result = await listTasks(db, 'account-1', filters);

    expect(tasks.eq).toHaveBeenCalledWith('account_id', 'account-1');
    expect(tasks.eq).toHaveBeenCalledWith('status', 'open');
    expect(tasks.eq).toHaveBeenCalledWith('assigned_to', filters.assignedTo);
    expect(tasks.gte).toHaveBeenCalledWith('due_at', filters.from);
    expect(tasks.lt).toHaveBeenCalledWith('due_at', filters.to);
    expect(tasks.limit).toHaveBeenCalledWith(101);
    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});
