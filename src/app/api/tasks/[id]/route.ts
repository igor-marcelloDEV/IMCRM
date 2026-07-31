import { requireRole } from '@/lib/auth/account';
import { parseTaskId, readTaskMutation } from '@/lib/tasks/contracts';
import { cancelTask, updateTask } from '@/lib/tasks/store';
import { taskErrorResponse, taskJson } from '@/lib/tasks/responses';

interface TaskRouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: TaskRouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const taskId = parseTaskId(id);
    const mutation = await readTaskMutation(request, 'update');
    const task = await updateTask(ctx.supabase, {
      accountId: ctx.accountId,
      taskId,
      mutation,
    });
    if (!task) return taskJson({ error: 'Tarefa não encontrada' }, 404);
    return taskJson({ task });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: TaskRouteContext) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const taskId = parseTaskId(id);
    const task = await cancelTask(ctx.supabase, ctx.accountId, taskId);
    if (!task) return taskJson({ error: 'Tarefa não encontrada' }, 404);
    return taskJson({ task });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
