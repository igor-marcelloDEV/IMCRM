import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { TaskContractError } from '@/lib/tasks/contracts';
import { TaskStoreError } from '@/lib/tasks/store';

const PRIVATE_NO_STORE = 'private, no-store';

export function withTaskNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', PRIVATE_NO_STORE);
  return response;
}

export function taskJson(body: unknown, status = 200): NextResponse {
  return withTaskNoStore(NextResponse.json(body, { status }));
}

export function taskErrorResponse(error: unknown): NextResponse {
  if (error instanceof TaskContractError || error instanceof TaskStoreError) {
    return taskJson({ error: error.message }, error.status);
  }
  return withTaskNoStore(toErrorResponse(error));
}
