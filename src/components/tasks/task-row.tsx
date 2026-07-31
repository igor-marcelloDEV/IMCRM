'use client';

import { useState } from 'react';
import {
  BriefcaseBusiness,
  CalendarClock,
  Check,
  Circle,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  Task,
  TaskContactOption,
  TaskDealOption,
} from '@/lib/tasks/types';

interface TaskRowProps {
  task: Task;
  canMutate: boolean;
  contact?: TaskContactOption;
  deal?: TaskDealOption;
  onToggle: (task: Task) => Promise<void>;
  onEdit: (task: Task) => void;
  onCancel: (task: Task) => void;
}

const PRIORITY_CLASS: Record<Task['priority'], string> = {
  low: 'border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300',
  normal: 'border-border bg-muted text-muted-foreground',
  high: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  urgent: 'border-destructive/30 bg-destructive/10 text-destructive',
};

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function TaskRow({
  task,
  canMutate,
  contact,
  deal,
  onToggle,
  onEdit,
  onCancel,
}: TaskRowProps) {
  const t = useTranslations('Tasks');
  const locale = useLocale();
  const [toggling, setToggling] = useState(false);
  const completed = task.status === 'completed';
  const due = task.due_at ? new Date(task.due_at) : null;
  const dueText =
    due && !Number.isNaN(due.getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(due)
      : null;

  async function handleToggle() {
    setToggling(true);
    try {
      await onToggle(task);
    } finally {
      setToggling(false);
    }
  }

  return (
    <li
      className={cn(
        'group flex gap-3 border-b border-border/70 px-3 py-3 last:border-b-0 sm:px-4',
        completed && 'bg-muted/20',
      )}
    >
      <button
        type="button"
        onClick={handleToggle}
        disabled={!canMutate || toggling}
        aria-label={
          completed
            ? t('actions.reopenTask', { title: task.title })
            : t('actions.completeTask', { title: task.title })
        }
        title={!canMutate ? t('states.readOnlyShort') : undefined}
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          canMutate && 'hover:bg-primary/10 hover:text-primary',
          completed && 'text-primary',
        )}
      >
        {toggling ? (
          <Loader2 className="size-5 animate-spin" />
        ) : completed ? (
          <Check className="size-5" />
        ) : (
          <Circle className="size-5" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => canMutate && onEdit(task)}
            disabled={!canMutate}
            className={cn(
              'min-w-0 flex-1 text-left text-sm font-medium text-foreground focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              canMutate && 'hover:text-primary',
              completed && 'text-muted-foreground line-through',
            )}
          >
            {task.title}
          </button>
          <Badge
            variant="outline"
            className={cn('shrink-0', PRIORITY_CLASS[task.priority])}
          >
            {t(`priority.${task.priority}`)}
          </Badge>
        </div>

        {task.description ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {task.description}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {dueText ? (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="size-3.5" />
              {dueText}
            </span>
          ) : (
            <span>{t('row.noDate')}</span>
          )}

          {task.assignee ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Avatar size="sm">
                {task.assignee.avatar_url ? (
                  <AvatarImage
                    src={task.assignee.avatar_url}
                    alt={task.assignee.full_name ?? t('row.unknownPerson')}
                  />
                ) : null}
                <AvatarFallback>
                  {initials(task.assignee.full_name)}
                </AvatarFallback>
              </Avatar>
              <span className="max-w-36 truncate">
                {task.assignee.full_name || t('row.unknownPerson')}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <UserRound className="size-3.5" />
              {t('row.unassigned')}
            </span>
          )}

          {task.contact_id ? (
            <span className="inline-flex max-w-44 items-center gap-1 truncate">
              <UserRound className="size-3.5 shrink-0" />
              {contact?.name ||
                contact?.phone ||
                t('row.linkedContact')}
            </span>
          ) : null}

          {task.deal_id ? (
            <span className="inline-flex max-w-44 items-center gap-1 truncate">
              <BriefcaseBusiness className="size-3.5 shrink-0" />
              {deal?.title || t('row.linkedDeal')}
            </span>
          ) : null}
        </div>
      </div>

      {canMutate ? (
        <div className="flex shrink-0 items-start gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onEdit(task)}
            aria-label={t('actions.editTask', { title: task.title })}
          >
            <Pencil />
          </Button>
          {completed ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleToggle}
              disabled={toggling}
              aria-label={t('actions.reopenTask', { title: task.title })}
            >
              <RotateCcw />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onCancel(task)}
            aria-label={t('actions.cancelTask', { title: task.title })}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

