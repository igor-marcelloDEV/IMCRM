import { localDayKey, startOfLocalDay } from '@/lib/dashboard/date-utils';
import type { Task } from '@/lib/tasks/types';

export type OpenTaskBucket =
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'unscheduled';

export interface TaskBuckets {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  unscheduled: Task[];
  completed: Task[];
}

const PRIORITY_RANK: Record<Task['priority'], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Convert an ISO instant into the value expected by datetime-local, using
 * local calendar components rather than slicing the UTC representation.
 */
export function isoToLocalDateTimeInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Parse a datetime-local value as local wall-clock time and return an ISO
 * instant. Never feeds a bare date to `new Date()`, avoiding the UTC-date
 * shift that moves Brazilian dates to the prior calendar day.
 */
export function localDateTimeInputToIso(value: string): string | null {
  if (!value) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function localDayDeadlineIso(
  dayOffset: number,
  now: Date = new Date(),
): string {
  const date = startOfLocalDay(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(17, 0, 0, 0);
  return date.toISOString();
}

export function localDayRange(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const from = startOfLocalDay(now);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function taskBucket(
  task: Pick<Task, 'due_at' | 'status'>,
  now: Date = new Date(),
): OpenTaskBucket | 'completed' | 'canceled' {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'canceled') return 'canceled';
  if (!task.due_at) return 'unscheduled';

  const dueKey = localDayKey(task.due_at);
  const todayKey = localDayKey(now);
  if (dueKey < todayKey) return 'overdue';
  if (dueKey === todayKey) return 'today';
  return 'upcoming';
}

function compareTasks(a: Task, b: Task): number {
  const dueA = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_VALUE;
  const dueB = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_VALUE;
  if (dueA !== dueB) return dueA - dueB;

  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  return a.created_at.localeCompare(b.created_at);
}

export function bucketTasks(
  tasks: Task[],
  now: Date = new Date(),
): TaskBuckets {
  const buckets: TaskBuckets = {
    overdue: [],
    today: [],
    upcoming: [],
    unscheduled: [],
    completed: [],
  };

  for (const task of tasks) {
    const bucket = taskBucket(task, now);
    if (bucket === 'canceled') continue;
    buckets[bucket].push(task);
  }

  for (const bucket of Object.values(buckets)) {
    bucket.sort(compareTasks);
  }
  return buckets;
}

