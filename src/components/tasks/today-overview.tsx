'use client';

import { TodayActivity } from '@/components/tasks/today-activity';
import { TaskWorkspace } from '@/components/tasks/task-workspace';

export function TodayOverview() {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <TaskWorkspace view="today" />
      <div className="xl:sticky xl:top-0">
        <TodayActivity />
      </div>
    </div>
  );
}

