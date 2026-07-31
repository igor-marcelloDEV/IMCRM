import { requireEntitledAccount } from '@/lib/auth/account';
import { parseActivityListFilters } from '@/lib/tasks/contracts';
import { listActivities } from '@/lib/tasks/store';
import { taskErrorResponse, taskJson } from '@/lib/tasks/responses';

export async function GET(request: Request) {
  try {
    const ctx = await requireEntitledAccount();
    const filters = parseActivityListFilters(request, ctx.userId);
    const { activities, nextCursor } = await listActivities(
      ctx.supabase,
      ctx.accountId,
      filters
    );
    return taskJson(nextCursor ? { activities, nextCursor } : { activities });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
