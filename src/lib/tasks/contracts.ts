import { parseListParams, type Cursor } from '@/lib/api/v1/pagination';
import type {
  Task,
  TaskActivity,
  TaskPerson,
  TaskPriority,
  TaskStatus,
} from '@/lib/tasks/types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE_RE = /^[a-z_]+\.[a-z_]+$/;
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export const TASK_SELECT =
  'id, title, description, status, priority, due_at, completed_at, assigned_to, created_by, contact_id, deal_id, order_id, conversation_id, created_at, updated_at';

export const ACTIVITY_SELECT =
  'id, event_type, entity_type, entity_id, actor_id, summary, metadata, task_id, contact_id, deal_id, order_id, conversation_id, created_at';

const TASK_STATUSES = new Set<TaskStatus>(['open', 'completed', 'canceled']);
const TASK_PRIORITIES = new Set<TaskPriority>([
  'low',
  'normal',
  'high',
  'urgent',
]);
const ACTIVITY_ENTITY_TYPES = new Set(['task', 'deal', 'note', 'order']);

const TASK_MUTATION_FIELDS = new Set([
  'title',
  'description',
  'status',
  'priority',
  'due_at',
  'assigned_to',
  'contact_id',
  'deal_id',
  'order_id',
  'conversation_id',
]);

export class TaskContractError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'TaskContractError';
  }
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  created_by: string | null;
  contact_id: string | null;
  deal_id: string | null;
  order_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  task_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  order_id: string | null;
  conversation_id: string | null;
  created_at: string;
}

export interface TaskListFilters {
  limit: number;
  cursor: Cursor | null;
  statuses: TaskStatus[] | null;
  priorities: TaskPriority[] | null;
  assignedTo: string | null;
  unassigned: boolean;
  from: string | null;
  to: string | null;
  contactId: string | null;
  dealId: string | null;
  orderId: string | null;
  conversationId: string | null;
}

export interface ActivityListFilters {
  limit: number;
  cursor: Cursor | null;
  from: string | null;
  to: string | null;
  eventTypes: string[] | null;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
  taskId: string | null;
  contactId: string | null;
  dealId: string | null;
  orderId: string | null;
  conversationId: string | null;
}

export type TaskMutation = Partial<
  Pick<
    TaskRow,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'due_at'
    | 'assigned_to'
    | 'contact_id'
    | 'deal_id'
    | 'order_id'
    | 'conversation_id'
  >
>;

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TaskContractError(`O campo '${field}' deve ser um UUID válido`);
  }
  return value.toLowerCase();
}

function parseNullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : parseUuid(value, field);
}

function parseDate(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!value.trim()) {
    throw new TaskContractError(`O filtro '${field}' não pode estar vazio`);
  }
  const match = ISO_INSTANT_RE.exec(value);
  const parsed = Date.parse(value);
  const [, year, month, day, hour, minute, second = '0'] = match ?? [];
  const calendarDate =
    match && new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const validCalendarDate =
    calendarDate &&
    calendarDate.getUTCFullYear() === Number(year) &&
    calendarDate.getUTCMonth() === Number(month) - 1 &&
    calendarDate.getUTCDate() === Number(day);
  if (
    !match ||
    !validCalendarDate ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    !Number.isFinite(parsed)
  ) {
    throw new TaskContractError(
      `O campo '${field}' deve ser uma data ISO válida`
    );
  }
  return new Date(parsed).toISOString();
}

function parseNullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new TaskContractError(
      `O campo '${field}' deve ser uma data ISO ou null`
    );
  }
  return parseDate(value, field);
}

function parseCsv<T extends string>(
  raw: string | null,
  field: string,
  allowed: ReadonlySet<T>
): T[] | null {
  if (raw === null) return null;
  const values = [...new Set(raw.split(',').map((value) => value.trim()))];
  if (
    values.length === 0 ||
    values.some((value) => !value || !allowed.has(value as T))
  ) {
    throw new TaskContractError(`Filtro '${field}' inválido`);
  }
  return values as T[];
}

function validateRange(from: string | null, to: string | null): void {
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    throw new TaskContractError("O intervalo exige 'from' anterior a 'to'");
  }
}

function queryUuid(params: URLSearchParams, field: string): string | null {
  const value = params.get(field);
  return value === null ? null : parseUuid(value, field);
}

export function parseTaskListFilters(
  request: Request,
  currentUserId: string
): TaskListFilters {
  const { limit, cursor } = parseListParams(request);
  const params = new URL(request.url).searchParams;
  const from = parseDate(params.get('from'), 'from');
  const to = parseDate(params.get('to'), 'to');
  validateRange(from, to);

  const assignee = params.get('assignee');
  let assignedTo: string | null = null;
  let unassigned = false;
  if (assignee && assignee !== 'all') {
    if (assignee === 'mine') assignedTo = currentUserId;
    else if (assignee === 'unassigned') unassigned = true;
    else assignedTo = parseUuid(assignee, 'assignee');
  }

  return {
    limit,
    cursor,
    statuses: parseCsv(params.get('status'), 'status', TASK_STATUSES),
    priorities: parseCsv(params.get('priority'), 'priority', TASK_PRIORITIES),
    assignedTo,
    unassigned,
    from,
    to,
    contactId: queryUuid(params, 'contact_id'),
    dealId: queryUuid(params, 'deal_id'),
    orderId: queryUuid(params, 'order_id'),
    conversationId: queryUuid(params, 'conversation_id'),
  };
}

export function parseActivityListFilters(
  request: Request,
  currentUserId: string
): ActivityListFilters {
  const { limit, cursor } = parseListParams(request);
  const params = new URL(request.url).searchParams;
  const from = parseDate(params.get('from'), 'from');
  const to = parseDate(params.get('to'), 'to');
  validateRange(from, to);

  const rawEventTypes = params.get('event_type');
  const eventTypes = rawEventTypes
    ? [...new Set(rawEventTypes.split(',').map((value) => value.trim()))]
    : null;
  if (
    eventTypes &&
    eventTypes.some((value) => !EVENT_TYPE_RE.test(value) || value.length > 80)
  ) {
    throw new TaskContractError("Filtro 'event_type' inválido");
  }

  const entityType = params.get('entity_type');
  if (entityType && !ACTIVITY_ENTITY_TYPES.has(entityType)) {
    throw new TaskContractError("Filtro 'entity_type' inválido");
  }
  const entityId = queryUuid(params, 'entity_id');
  if ((entityType && !entityId) || (!entityType && entityId)) {
    throw new TaskContractError(
      "Os filtros 'entity_type' e 'entity_id' devem ser usados juntos"
    );
  }

  const actor = params.get('actor');
  const actorId = actor
    ? actor === 'mine'
      ? currentUserId
      : parseUuid(actor, 'actor')
    : null;

  return {
    limit,
    cursor,
    from,
    to,
    eventTypes,
    entityType,
    entityId,
    actorId,
    taskId: queryUuid(params, 'task_id'),
    contactId: queryUuid(params, 'contact_id'),
    dealId: queryUuid(params, 'deal_id'),
    orderId: queryUuid(params, 'order_id'),
    conversationId: queryUuid(params, 'conversation_id'),
  };
}

export async function readTaskMutation(
  request: Request,
  mode: 'create' | 'update'
): Promise<TaskMutation> {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskContractError('O corpo deve ser um objeto JSON');
  }

  const unknownField = Object.keys(body).find(
    (field) => !TASK_MUTATION_FIELDS.has(field)
  );
  if (unknownField) {
    throw new TaskContractError(`Campo desconhecido: '${unknownField}'`);
  }

  const mutation: TaskMutation = {};

  if ('title' in body) {
    if (typeof body.title !== 'string') {
      throw new TaskContractError("O campo 'title' deve ser texto");
    }
    const title = body.title.trim();
    if (!title || title.length > 200) {
      throw new TaskContractError(
        "O campo 'title' deve ter entre 1 e 200 caracteres"
      );
    }
    mutation.title = title;
  } else if (mode === 'create') {
    throw new TaskContractError("O campo 'title' é obrigatório");
  }

  if ('description' in body) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new TaskContractError(
        "O campo 'description' deve ser texto ou null"
      );
    }
    const description =
      typeof body.description === 'string' ? body.description.trim() : null;
    if (description && description.length > 5000) {
      throw new TaskContractError(
        "O campo 'description' aceita no máximo 5000 caracteres"
      );
    }
    mutation.description = description || null;
  }

  if ('status' in body) {
    if (!TASK_STATUSES.has(body.status as TaskStatus)) {
      throw new TaskContractError("O campo 'status' é inválido");
    }
    mutation.status = body.status as TaskStatus;
  }

  if ('priority' in body) {
    if (!TASK_PRIORITIES.has(body.priority as TaskPriority)) {
      throw new TaskContractError("O campo 'priority' é inválido");
    }
    mutation.priority = body.priority as TaskPriority;
  }

  if ('due_at' in body) {
    mutation.due_at = parseNullableDate(body.due_at, 'due_at');
  }

  for (const field of [
    'assigned_to',
    'contact_id',
    'deal_id',
    'order_id',
    'conversation_id',
  ] as const) {
    if (field in body) {
      mutation[field] = parseNullableUuid(body[field], field);
    }
  }

  if (mode === 'update' && Object.keys(mutation).length === 0) {
    throw new TaskContractError('Informe ao menos um campo para atualizar');
  }

  return mutation;
}

export function serializeTask(
  row: TaskRow,
  people: ReadonlyMap<string, TaskPerson>
): Task {
  return {
    ...row,
    assignee: row.assigned_to ? (people.get(row.assigned_to) ?? null) : null,
    creator: row.created_by ? (people.get(row.created_by) ?? null) : null,
  };
}

export function serializeActivity(
  row: ActivityRow,
  people: ReadonlyMap<string, TaskPerson>
): TaskActivity {
  return {
    ...row,
    metadata:
      row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    actor: row.actor_id ? (people.get(row.actor_id) ?? null) : null,
  };
}

export function parseTaskId(id: string): string {
  return parseUuid(id, 'id');
}
