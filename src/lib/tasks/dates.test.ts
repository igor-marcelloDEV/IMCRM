import { describe, expect, it } from 'vitest';

import {
  bucketTasks,
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
  localDayDeadlineIso,
  localDayRange,
  taskBucket,
} from './dates';
import type { Task } from './types';

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Follow up',
    description: null,
    status: 'open',
    priority: 'normal',
    due_at: null,
    completed_at: null,
    assigned_to: null,
    created_by: 'user-1',
    contact_id: null,
    deal_id: null,
    order_id: null,
    conversation_id: null,
    created_at: '2026-07-29T10:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
    assignee: null,
    creator: null,
    ...overrides,
  };
}

describe('task local-date helpers', () => {
  it('round-trips datetime-local through local calendar components', () => {
    const input = '2026-07-29T17:30';
    expect(isoToLocalDateTimeInput(localDateTimeInputToIso(input))).toBe(input);
  });

  it('creates local day boundaries and the default 17:00 deadline', () => {
    const now = new Date(2026, 6, 29, 23, 40);
    const range = localDayRange(now);

    expect(new Date(range.from).getHours()).toBe(0);
    expect(new Date(range.to).getDate()).toBe(30);
    expect(new Date(localDayDeadlineIso(0, now)).getHours()).toBe(17);
    expect(new Date(localDayDeadlineIso(1, now)).getDate()).toBe(30);
  });

  it('classifies by local calendar day instead of elapsed hours', () => {
    const now = new Date(2026, 6, 29, 23, 30);
    expect(
      taskBucket(task({ due_at: new Date(2026, 6, 29, 8).toISOString() }), now),
    ).toBe('today');
    expect(
      taskBucket(task({ due_at: new Date(2026, 6, 28, 23, 59).toISOString() }), now),
    ).toBe('overdue');
    expect(
      taskBucket(task({ due_at: new Date(2026, 6, 30, 0, 1).toISOString() }), now),
    ).toBe('upcoming');
  });

  it('groups, omits canceled rows, and sorts due tasks chronologically', () => {
    const now = new Date(2026, 6, 29, 12);
    const buckets = bucketTasks(
      [
        task({ id: 'later', due_at: new Date(2026, 6, 29, 17).toISOString() }),
        task({ id: 'earlier', due_at: new Date(2026, 6, 29, 9).toISOString() }),
        task({ id: 'none' }),
        task({ id: 'done', status: 'completed' }),
        task({ id: 'gone', status: 'canceled' }),
      ],
      now,
    );

    expect(buckets.today.map((item) => item.id)).toEqual(['earlier', 'later']);
    expect(buckets.unscheduled.map((item) => item.id)).toEqual(['none']);
    expect(buckets.completed.map((item) => item.id)).toEqual(['done']);
    expect(Object.values(buckets).flat()).not.toContainEqual(
      expect.objectContaining({ id: 'gone' }),
    );
  });
});

