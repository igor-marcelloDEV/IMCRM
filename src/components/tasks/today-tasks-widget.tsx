'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  CalendarCheck2,
  CheckCircle2,
  ListTodo,
  RefreshCw,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { listTasks } from '@/lib/tasks/client';
import { bucketTasks, localDayRange } from '@/lib/tasks/dates';
import type { Task } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

export function TodayTasksWidget() {
  const t = useTranslations('Tasks');
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    try {
      const { to } = localDayRange();
      const result = await listTasks({
        status: ['open'],
        assignee: 'mine',
        to,
        limit: 25,
        signal,
      });
      setTasks(result.tasks);
    } catch (loadError) {
      if (
        loadError instanceof DOMException &&
        loadError.name === 'AbortError'
      ) {
        return;
      }
      setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, user]);

  const buckets = useMemo(() => bucketTasks(tasks), [tasks]);
  const visible = [...buckets.overdue, ...buckets.today].slice(0, 4);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <CalendarCheck2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {t('widget.title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('widget.description', {
              overdue: buckets.overdue.length,
              today: buckets.today.length,
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('actions.refresh')}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </header>

      {loading ? (
        <div className="grid gap-2 p-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-10 animate-pulse rounded-lg bg-muted"
            />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-4 py-5 text-sm text-destructive">
          <AlertCircle className="size-4" />
          <span>{t('widget.error')}</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-5 text-sm text-muted-foreground">
          <CheckCircle2 className="size-5 text-primary" />
          <span>{t('widget.empty')}</span>
        </div>
      ) : (
        <ul className="grid gap-px bg-border sm:grid-cols-2">
          {visible.map((task) => (
            <li key={task.id} className="bg-card">
              <Link
                href="/today"
                className="flex min-h-11 items-center gap-2 px-4 py-2 text-sm text-foreground hover:bg-muted/40"
              >
                {buckets.overdue.some((item) => item.id === task.id) ? (
                  <AlertCircle className="size-4 shrink-0 text-destructive" />
                ) : (
                  <ListTodo className="size-4 shrink-0 text-primary" />
                )}
                <span className="truncate">{task.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <footer className="border-t border-border px-4 py-2.5">
        <Link
          href="/today"
          className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
        >
          {t('widget.openToday')}
          <ArrowRight className="size-3.5" />
        </Link>
      </footer>
    </section>
  );
}

