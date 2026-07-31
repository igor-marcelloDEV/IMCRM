'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  BriefcaseBusiness,
  CheckCircle2,
  FileText,
  Package,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { listTaskActivities } from '@/lib/tasks/client';
import { localDayRange } from '@/lib/tasks/dates';
import type { TaskActivity } from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

function activityPresentation(item: TaskActivity) {
  if (item.entity_type === 'task') {
    return {
      icon: CheckCircle2,
      href: '/tasks',
      className: 'bg-primary/10 text-primary',
    };
  }
  if (item.entity_type === 'deal') {
    return {
      icon: BriefcaseBusiness,
      href: '/pipelines',
      className: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
    };
  }
  if (item.entity_type === 'order') {
    return {
      icon: Package,
      href: '/orders',
      className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    };
  }
  if (item.entity_type === 'note') {
    return {
      icon: FileText,
      href: '/contacts',
      className: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
    };
  }
  return {
    icon: Activity,
    href: null,
    className: 'bg-muted text-muted-foreground',
  };
}

export function TodayActivity() {
  const t = useTranslations('Tasks');
  const locale = useLocale();
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const range = localDayRange();
        const result = await listTaskActivities({
          ...range,
          limit: 15,
          signal,
        });
        setActivities(result.activities);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === 'AbortError'
        ) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : t('states.loadError'),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <section
      aria-labelledby="today-activity-heading"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Activity className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="today-activity-heading"
            className="text-sm font-semibold text-foreground"
          >
            {t('activity.title')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('activity.description')}
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

      <div aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="space-y-3 p-4" aria-label={t('states.loading')}>
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <div className="size-8 animate-pulse rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-24 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{t('activity.errorTitle')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : activities.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Activity className="size-5" />
            </span>
            <p className="text-sm font-medium text-foreground">
              {t('activity.emptyTitle')}
            </p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {t('activity.emptyDescription')}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {activities.map((item) => {
              const presentation = activityPresentation(item);
              const Icon = presentation.icon;
              const content = (
                <div className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                      presentation.className,
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-foreground">
                      {item.summary}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <UserRound className="size-3" />
                      <span className="truncate">
                        {item.actor?.full_name || t('activity.system')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={item.created_at}>
                        {new Intl.DateTimeFormat(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(item.created_at))}
                      </time>
                    </p>
                  </div>
                </div>
              );
              return (
                <li key={item.id} className="hover:bg-muted/30">
                  {presentation.href ? (
                    <Link href={presentation.href} className="block">
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
