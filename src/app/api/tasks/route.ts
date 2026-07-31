import { requireEntitledAccount, requireRole } from '@/lib/auth/account';
import { parseTaskListFilters, readTaskMutation } from '@/lib/tasks/contracts';
import { createTask, listTasks } from '@/lib/tasks/store';
import { taskErrorResponse, taskJson } from '@/lib/tasks/responses';

export async function GET(request: Request) {
  try {
    const ctx = await requireEntitledAccount();
    const filters = parseTaskListFilters(request, ctx.userId);
    const { tasks, nextCursor } = await listTasks(
      ctx.supabase,
      ctx.accountId,
      filters
    );
    return taskJson(nextCursor ? { tasks, nextCursor } : { tasks });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const mutation = await readTaskMutation(request, 'create');
    const task = await createTask(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      mutation,
    });
    return taskJson({ task }, 201);
  } catch (error) {
    return taskErrorResponse(error);
  }
}
