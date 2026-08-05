'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertCircle,
  CalendarCheck2,
  CalendarDays,
  CalendarRange,
  CheckCheck,
  Clock3,
  ListTodo,
  Loader2,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { TaskEditorDialog } from '@/components/tasks/task-editor-dialog';
import { TaskQuickAdd } from '@/components/tasks/task-quick-add';
import { TaskRow } from '@/components/tasks/task-row';
import { TodayOperations } from '@/components/tasks/today-operations';
import { useTaskResources } from '@/components/tasks/use-task-resources';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { localDayKey } from '@/lib/dashboard/date-utils';
import {
  cancelTask,
  createTask,
  listTasks,
  updateTask,
} from '@/lib/tasks/client';
import { bucketTasks, localDayRange } from '@/lib/tasks/dates';
import type {
  Task,
  TaskDraft,
  TaskResources,
} from '@/lib/tasks/types';
import { cn } from '@/lib/utils';

type TaskView = 'today' | 'all' | 'contact';
type AssigneeFilter = 'mine' | 'all';
type EditorState =
  | { kind: 'create'; initial: Partial<TaskDraft> }
  | { kind: 'edit'; task: Task }
  | null;

interface TaskWorkspaceProps {
  view: TaskView;
  compact?: boolean;
  fixedContact?: { id: string; label: string } | null;
  lockToMine?: boolean;
}

interface TaskSectionProps {
  id: string;
  title: string;
  description: string;
  tasks: Task[];
  icon: typeof CalendarDays;
  iconClassName: string;
  canMutate: boolean;
  resources: TaskResources;
  onToggle: (task: Task) => Promise<void>;
  onEdit: (task: Task) => void;
  onCancel: (task: Task) => void;
}

function TaskSection({
  id,
  title,
  description,
  tasks,
  icon: Icon,
  iconClassName,
  canMutate,
  resources,
  onToggle,
  onEdit,
  onCancel,
}: TaskSectionProps) {
  const t = useTranslations('Tasks');
  const contactById = useMemo(
    () => new Map(resources.contacts.map((contact) => [contact.id, contact])),
    [resources.contacts],
  );
  const dealById = useMemo(
    () => new Map(resources.deals.map((deal) => [deal.id, deal])),
    [resources.deals],
  );

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-3 border-b border-border px-3 py-3 sm:px-4">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            iconClassName,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-heading`} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
      </header>

      {tasks.length ? (
        <ul>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              canMutate={canMutate}
              contact={
                task.contact_id
                  ? contactById.get(task.contact_id)
                  : undefined
              }
              deal={task.deal_id ? dealById.get(task.deal_id) : undefined}
              onToggle={onToggle}
              onEdit={onEdit}
              onCancel={onCancel}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-5 text-center text-xs text-muted-foreground">
          {t('sections.empty')}
        </p>
      )}
    </section>
  );
}

function WorkspaceSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div aria-hidden="true" className="space-y-3">
      {!compact ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-20 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      ) : null}
      {Array.from({ length: compact ? 2 : 4 }).map((_, index) => (
        <div
          key={index}
          className="h-28 animate-pulse rounded-xl bg-muted"
        />
      ))}
    </div>
  );
}

export function TaskWorkspace({
  view,
  compact = false,
  fixedContact = null,
  lockToMine = false,
}: TaskWorkspaceProps) {
  const t = useTranslations('Tasks');
  const locale = useLocale();
  const { user, profileLoading } = useAuth();
  const canMutate = useCan('send-messages');
  const { resources, loading: resourcesLoading, error: resourcesError } =
    useTaskResources();
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>(
    view === 'contact' ? 'all' : 'mine',
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [editor, setEditor] = useState<EditorState>(null);
  const [cancelTarget, setCancelTarget] = useState<Task | null>(null);
  const [canceling, setCanceling] = useState(false);

  const load = useCallback(
    async ({
      cursor,
      signal,
    }: {
      cursor?: string;
      signal?: AbortSignal;
    } = {}) => {
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setTasks([]);
      }
      setError('');

      try {
        const todayRange = view === 'today' ? localDayRange() : null;
        const commonFilters = {
          assignee: assigneeFilter,
          contactId: fixedContact?.id,
          limit: 100,
          signal,
        } as const;
        const payload =
          view === 'today' && !cursor
            ? await Promise.all([
                listTasks({
                  ...commonFilters,
                  status: ['open'],
                  to: todayRange?.to,
                }),
                listTasks({
                  ...commonFilters,
                  status: ['completed'],
                }),
              ]).then(([openResult, completedResult]) => ({
                tasks: [...openResult.tasks, ...completedResult.tasks],
                nextCursor: undefined,
              }))
            : await listTasks({
                ...commonFilters,
                status: ['open', 'completed'],
                cursor,
              });
        setTasks((current) => {
          if (!cursor) return payload.tasks;
          const byId = new Map(current.map((task) => [task.id, task]));
          for (const task of payload.tasks) byId.set(task.id, task);
          return [...byId.values()];
        });
        setNextCursor(payload.nextCursor);
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
        if (!signal?.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [assigneeFilter, fixedContact?.id, t, view],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load({ signal: controller.signal });
    return () => controller.abort();
  }, [load]);

  const buckets = useMemo(() => {
    const grouped = bucketTasks(tasks);
    if (view !== 'today') return grouped;
    const todayKey = localDayKey(new Date());
    return {
      ...grouped,
      completed: grouped.completed.filter(
        (task) =>
          task.completed_at &&
          localDayKey(task.completed_at) === todayKey,
      ),
    };
  }, [tasks, view]);
  const openCount =
    buckets.overdue.length +
    buckets.today.length +
    buckets.upcoming.length +
    buckets.unscheduled.length;

  function upsertVisible(nextTask: Task) {
    setTasks((current) => {
      const withoutCurrent = current.filter((task) => task.id !== nextTask.id);
      if (nextTask.status === 'canceled') return withoutCurrent;
      if (
        assigneeFilter === 'mine' &&
        nextTask.assigned_to !== user?.id
      ) {
        return withoutCurrent;
      }
      if (
        fixedContact?.id &&
        nextTask.contact_id !== fixedContact.id
      ) {
        return withoutCurrent;
      }
      return [nextTask, ...withoutCurrent];
    });
  }

  async function handleCreate(draft: TaskDraft) {
    const created = await createTask(draft);
    upsertVisible(created);
    toast.success(t('toast.created'));
  }

  async function handleEditorSave(draft: TaskDraft) {
    if (editor?.kind === 'edit') {
      const updated = await updateTask(editor.task.id, draft);
      upsertVisible(updated);
      toast.success(t('toast.updated'));
      return;
    }
    await handleCreate(draft);
  }

  async function handleToggle(task: Task) {
    try {
      const status = task.status === 'completed' ? 'open' : 'completed';
      const updated = await updateTask(task.id, { status });
      upsertVisible(updated);
      toast.success(
        status === 'completed'
          ? t('toast.completed')
          : t('toast.reopened'),
      );
    } catch (toggleError) {
      toast.error(
        toggleError instanceof Error
          ? toggleError.message
          : t('states.saveError'),
      );
    }
  }

  async function handleCancel() {
    if (!cancelTarget) return;
    setCanceling(true);
    try {
      const canceled = await cancelTask(cancelTarget.id);
      upsertVisible(canceled);
      setCancelTarget(null);
      toast.success(t('toast.canceled'));
    } catch (cancelError) {
      toast.error(
        cancelError instanceof Error
          ? cancelError.message
          : t('states.saveError'),
      );
    } finally {
      setCanceling(false);
    }
  }

  const sectionDefinitions = [
    {
      id: 'overdue',
      title: t('sections.overdue'),
      description: t('sections.overdueDescription'),
      tasks: buckets.overdue,
      icon: AlertCircle,
      iconClassName: 'bg-destructive/10 text-destructive',
    },
    {
      id: 'today',
      title: t('sections.today'),
      description: t('sections.todayDescription'),
      tasks: buckets.today,
      icon: CalendarCheck2,
      iconClassName: 'bg-primary/10 text-primary',
    },
    {
      id: 'upcoming',
      title: t('sections.upcoming'),
      description: t('sections.upcomingDescription'),
      tasks: buckets.upcoming,
      icon: CalendarRange,
      iconClassName: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
    },
    {
      id: 'unscheduled',
      title: t('sections.unscheduled'),
      description: t('sections.unscheduledDescription'),
      tasks: buckets.unscheduled,
      icon: Clock3,
      iconClassName: 'bg-muted text-muted-foreground',
    },
    {
      id: 'completed',
      title: t('sections.completed'),
      description: t('sections.completedDescription'),
      tasks: buckets.completed,
      icon: CheckCheck,
      iconClassName: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    },
  ];
  const visibleSections =
    view === 'today'
      ? sectionDefinitions.filter(({ id }) =>
          ['overdue', 'today', 'completed'].includes(id),
        )
      : sectionDefinitions;

  const headingKey = view === 'today' ? 'today' : 'page';
  const formattedDate = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
  }).format(new Date());

  return (
    <div className={cn('space-y-4', compact && 'space-y-3')}>
      {!compact ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t(`${headingKey}.title`)}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(`${headingKey}.description`)}
            </p>
            {view === 'today' ? (
              <p className="mt-1 text-xs capitalize text-muted-foreground">
                {formattedDate}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
            {t('actions.refresh')}
          </Button>
        </div>
      ) : null}

      {!compact && view === 'today' ? <TodayOperations /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {!lockToMine && <div
          role="group"
          aria-label={t('filters.assigneeLabel')}
          className="inline-flex rounded-lg border border-border bg-card p-1"
        >
          {(['mine', 'all'] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={assigneeFilter === filter}
              onClick={() => setAssigneeFilter(filter)}
              className={cn(
                'min-h-8 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                assigneeFilter === filter
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t(`filters.${filter}`)}
            </button>
          ))}
        </div>}
        {compact ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
            {t('actions.refresh')}
          </Button>
        ) : null}
      </div>

      {!profileLoading && !canMutate ? (
        <Alert>
          <LockKeyhole />
          <AlertTitle>{t('states.readOnlyTitle')}</AlertTitle>
          <AlertDescription>{t('states.readOnlyDescription')}</AlertDescription>
        </Alert>
      ) : canMutate ? (
        <TaskQuickAdd
          defaultDue={view === 'all' ? 'none' : 'today'}
          currentUserId={user?.id ?? null}
          fixedContactId={fixedContact?.id}
          onCreate={handleCreate}
          onOpenEditor={(initial) =>
            setEditor({ kind: 'create', initial })
          }
        />
      ) : null}

      {!compact && !loading && !error ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            {
              label: t('counters.open'),
              value: openCount,
              icon: ListTodo,
              className: 'text-foreground',
            },
            {
              label: t('counters.overdue'),
              value: buckets.overdue.length,
              icon: AlertCircle,
              className: 'text-destructive',
            },
            {
              label: t('counters.today'),
              value: buckets.today.length,
              icon: CalendarDays,
              className: 'text-primary',
            },
            {
              label: t('counters.completed'),
              value: buckets.completed.length,
              icon: CheckCheck,
              className: 'text-emerald-600 dark:text-emerald-300',
            },
          ].map((counter) => (
            <div
              key={counter.label}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {counter.label}
                </p>
                <counter.icon className={cn('size-4', counter.className)} />
              </div>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
                {counter.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div aria-busy={loading} aria-live="polite">
        {loading ? (
          <WorkspaceSkeleton compact={compact} />
        ) : error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t('states.loadErrorTitle')}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load()}
              >
                <RotateCcw />
                {t('actions.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className={cn('space-y-4', compact && 'space-y-3')}>
            {visibleSections.map((section) => (
              <TaskSection
                key={section.id}
                {...section}
                canMutate={canMutate}
                resources={resources}
                onToggle={handleToggle}
                onEdit={(task) => setEditor({ kind: 'edit', task })}
                onCancel={setCancelTarget}
              />
            ))}
          </div>
        )}
      </div>

      {nextCursor && !loading ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => void load({ cursor: nextCursor })}
            disabled={loadingMore}
          >
            {loadingMore ? <Loader2 className="animate-spin" /> : <ListTodo />}
            {loadingMore ? t('actions.loadingMore') : t('actions.loadMore')}
          </Button>
        </div>
      ) : null}

      {editor ? (
        <TaskEditorDialog
          key={
            editor.kind === 'edit'
              ? `edit-${editor.task.id}`
              : `create-${fixedContact?.id ?? 'general'}`
          }
          task={editor.kind === 'edit' ? editor.task : null}
          initial={editor.kind === 'create' ? editor.initial : undefined}
          resources={resources}
          resourcesLoading={resourcesLoading}
          resourcesError={resourcesError}
          fixedContact={fixedContact}
          onClose={() => setEditor(null)}
          onSave={handleEditorSave}
        />
      ) : null}

      <Dialog
        open={Boolean(cancelTarget)}
        onOpenChange={(open) => !open && !canceling && setCancelTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('cancel.title')}</DialogTitle>
            <DialogDescription>
              {t('cancel.description', {
                title: cancelTarget?.title ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={canceling}
            >
              {t('actions.close')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleCancel}
              disabled={canceling}
            >
              {canceling ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              {canceling ? t('actions.canceling') : t('actions.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
