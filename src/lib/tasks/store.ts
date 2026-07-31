import type { SupabaseClient } from '@supabase/supabase-js';
import { buildPage, keysetFilter } from '@/lib/api/v1/pagination';
import {
  ACTIVITY_SELECT,
  TASK_SELECT,
  serializeActivity,
  serializeTask,
  type ActivityListFilters,
  type ActivityRow,
  type TaskListFilters,
  type TaskMutation,
  type TaskRow,
} from '@/lib/tasks/contracts';
import type { Task, TaskActivity, TaskPerson } from '@/lib/tasks/types';

interface DatabaseErrorLike {
  code?: string;
  message?: string;
}

export class TaskStoreError extends Error {
  constructor(
    message: string,
    readonly status = 500
  ) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

function mutationError(
  operation: string,
  error: DatabaseErrorLike
): TaskStoreError {
  if (
    error.code === '23502' ||
    error.code === '23503' ||
    error.code === '23514' ||
    error.code === '22P02'
  ) {
    return new TaskStoreError(
      'Responsável ou vínculo informado não pertence a esta conta',
      400
    );
  }
  if (error.code === '23505') {
    return new TaskStoreError(
      'A tarefa conflita com um registro existente',
      409
    );
  }
  console.error(`[tasks] ${operation}:`, error);
  return new TaskStoreError(`Não foi possível ${operation}`);
}

async function loadPeople(
  db: SupabaseClient,
  accountId: string,
  userIds: Array<string | null>
): Promise<Map<string, TaskPerson>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, avatar_url')
    .eq('account_id', accountId)
    .in('user_id', ids);
  if (error) {
    console.error('[tasks] load people:', error);
    throw new TaskStoreError('Não foi possível carregar os responsáveis');
  }

  return new Map(
    ((data ?? []) as TaskPerson[]).map((person) => [person.user_id, person])
  );
}

async function hydrateTasks(
  db: SupabaseClient,
  accountId: string,
  rows: TaskRow[]
): Promise<Task[]> {
  const people = await loadPeople(
    db,
    accountId,
    rows.flatMap((row) => [row.assigned_to, row.created_by])
  );
  return rows.map((row) => serializeTask(row, people));
}

async function hydrateActivities(
  db: SupabaseClient,
  accountId: string,
  rows: ActivityRow[]
): Promise<TaskActivity[]> {
  const people = await loadPeople(
    db,
    accountId,
    rows.map((row) => row.actor_id)
  );
  return rows.map((row) => serializeActivity(row, people));
}

export async function listTasks(
  db: SupabaseClient,
  accountId: string,
  filters: TaskListFilters
): Promise<{ tasks: Task[]; nextCursor: string | null }> {
  let query = db
    .from('tasks')
    .select(TASK_SELECT)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(filters.limit + 1);

  if (filters.statuses?.length === 1) {
    query = query.eq('status', filters.statuses[0]);
  } else if (filters.statuses?.length) {
    query = query.in('status', filters.statuses);
  }

  if (filters.priorities?.length === 1) {
    query = query.eq('priority', filters.priorities[0]);
  } else if (filters.priorities?.length) {
    query = query.in('priority', filters.priorities);
  }

  if (filters.assignedTo) {
    query = query.eq('assigned_to', filters.assignedTo);
  } else if (filters.unassigned) {
    query = query.is('assigned_to', null);
  }

  if (filters.from) query = query.gte('due_at', filters.from);
  if (filters.to) query = query.lt('due_at', filters.to);
  if (filters.contactId) query = query.eq('contact_id', filters.contactId);
  if (filters.dealId) query = query.eq('deal_id', filters.dealId);
  if (filters.orderId) query = query.eq('order_id', filters.orderId);
  if (filters.conversationId) {
    query = query.eq('conversation_id', filters.conversationId);
  }

  const cursorFilter = keysetFilter(filters.cursor);
  if (cursorFilter) query = query.or(cursorFilter);

  const { data, error } = await query;
  if (error) {
    console.error('[tasks] list tasks:', error);
    throw new TaskStoreError('Não foi possível carregar as tarefas');
  }

  const page = buildPage((data ?? []) as TaskRow[], filters.limit);
  return {
    tasks: await hydrateTasks(db, accountId, page.items),
    nextCursor: page.nextCursor,
  };
}

export async function createTask(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    mutation: TaskMutation;
  }
): Promise<Task> {
  const { data, error } = await db
    .from('tasks')
    .insert({
      ...args.mutation,
      account_id: args.accountId,
      created_by: args.userId,
    })
    .select(TASK_SELECT)
    .maybeSingle();
  if (error) throw mutationError('criar a tarefa', error);
  if (!data) throw new TaskStoreError('Não foi possível criar a tarefa');

  return (await hydrateTasks(db, args.accountId, [data as TaskRow]))[0];
}

export async function updateTask(
  db: SupabaseClient,
  args: {
    accountId: string;
    taskId: string;
    mutation: TaskMutation;
  }
): Promise<Task | null> {
  const { data, error } = await db
    .from('tasks')
    .update(args.mutation)
    .eq('id', args.taskId)
    .eq('account_id', args.accountId)
    .select(TASK_SELECT)
    .maybeSingle();
  if (error) throw mutationError('atualizar a tarefa', error);
  if (!data) return null;

  return (await hydrateTasks(db, args.accountId, [data as TaskRow]))[0];
}

export async function cancelTask(
  db: SupabaseClient,
  accountId: string,
  taskId: string
): Promise<Task | null> {
  return updateTask(db, {
    accountId,
    taskId,
    mutation: { status: 'canceled' },
  });
}

export async function listActivities(
  db: SupabaseClient,
  accountId: string,
  filters: ActivityListFilters
): Promise<{ activities: TaskActivity[]; nextCursor: string | null }> {
  let query = db
    .from('activities')
    .select(ACTIVITY_SELECT)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(filters.limit + 1);

  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lt('created_at', filters.to);
  if (filters.eventTypes?.length === 1) {
    query = query.eq('event_type', filters.eventTypes[0]);
  } else if (filters.eventTypes?.length) {
    query = query.in('event_type', filters.eventTypes);
  }
  if (filters.entityType) {
    query = query.eq('entity_type', filters.entityType);
  }
  if (filters.entityId) query = query.eq('entity_id', filters.entityId);
  if (filters.actorId) query = query.eq('actor_id', filters.actorId);
  if (filters.taskId) query = query.eq('task_id', filters.taskId);
  if (filters.contactId) query = query.eq('contact_id', filters.contactId);
  if (filters.dealId) query = query.eq('deal_id', filters.dealId);
  if (filters.orderId) query = query.eq('order_id', filters.orderId);
  if (filters.conversationId) {
    query = query.eq('conversation_id', filters.conversationId);
  }

  const cursorFilter = keysetFilter(filters.cursor);
  if (cursorFilter) query = query.or(cursorFilter);

  const { data, error } = await query;
  if (error) {
    console.error('[tasks] list activities:', error);
    throw new TaskStoreError('Não foi possível carregar as atividades');
  }

  const page = buildPage((data ?? []) as ActivityRow[], filters.limit);
  return {
    activities: await hydrateActivities(db, accountId, page.items),
    nextCursor: page.nextCursor,
  };
}
