import { describe, expect, it } from 'vitest';
import {
  TaskContractError,
  parseActivityListFilters,
  parseTaskListFilters,
  readTaskMutation,
} from './contracts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';

function request(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST'
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('task request contracts', () => {
  it('normalizes a valid create payload and leaves server fields unavailable', async () => {
    await expect(
      readTaskMutation(
        request('/api/tasks', {
          title: '  Retornar para a cliente  ',
          description: '  Confirmar orçamento  ',
          priority: 'high',
          due_at: '2026-07-30T09:00:00-03:00',
          assigned_to: USER_ID.toUpperCase(),
          contact_id: CONTACT_ID,
        }),
        'create'
      )
    ).resolves.toEqual({
      title: 'Retornar para a cliente',
      description: 'Confirmar orçamento',
      priority: 'high',
      due_at: '2026-07-30T12:00:00.000Z',
      assigned_to: USER_ID,
      contact_id: CONTACT_ID,
    });
  });

  it('rejects unknown/server-controlled fields and empty updates', async () => {
    await expect(
      readTaskMutation(
        request('/api/tasks', {
          title: 'Tarefa',
          completed_at: '2026-07-30T12:00:00.000Z',
        }),
        'create'
      )
    ).rejects.toThrow("Campo desconhecido: 'completed_at'");

    await expect(
      readTaskMutation(request('/api/tasks/task', {}, 'PATCH'), 'update')
    ).rejects.toThrow('ao menos um campo');
  });

  it('parses bounded list filters and resolves assignee=mine', () => {
    const parsed = parseTaskListFilters(
      request(
        `/api/tasks?status=open,completed&priority=urgent,high&assignee=mine&from=2026-07-29T03:00:00.000Z&to=2026-07-30T03:00:00.000Z&contact_id=${CONTACT_ID}&limit=999`
      ),
      USER_ID
    );

    expect(parsed).toMatchObject({
      limit: 100,
      statuses: ['open', 'completed'],
      priorities: ['urgent', 'high'],
      assignedTo: USER_ID,
      unassigned: false,
      from: '2026-07-29T03:00:00.000Z',
      to: '2026-07-30T03:00:00.000Z',
      contactId: CONTACT_ID,
    });
  });

  it('rejects invalid UUIDs, status values and reversed intervals', () => {
    expect(() =>
      parseTaskListFilters(request('/api/tasks?contact_id=not-a-uuid'), USER_ID)
    ).toThrow(TaskContractError);
    expect(() =>
      parseTaskListFilters(request('/api/tasks?status=done'), USER_ID)
    ).toThrow("Filtro 'status' inválido");
    expect(() =>
      parseTaskListFilters(
        request(
          '/api/tasks?from=2026-07-30T03:00:00.000Z&to=2026-07-29T03:00:00.000Z'
        ),
        USER_ID
      )
    ).toThrow("'from' anterior a 'to'");
    expect(() =>
      parseTaskListFilters(
        request('/api/tasks?from=2026-02-31T09:00:00-03:00'),
        USER_ID
      )
    ).toThrow('deve ser uma data ISO válida');
  });

  it('requires activity entity type and id together', () => {
    expect(() =>
      parseActivityListFilters(
        request(`/api/activities?entity_id=${CONTACT_ID}`),
        USER_ID
      )
    ).toThrow('devem ser usados juntos');

    expect(
      parseActivityListFilters(
        request(
          `/api/activities?entity_type=task&entity_id=${CONTACT_ID}&actor=mine`
        ),
        USER_ID
      )
    ).toMatchObject({
      entityType: 'task',
      entityId: CONTACT_ID,
      actorId: USER_ID,
    });
  });
});
