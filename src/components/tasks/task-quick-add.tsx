'use client';

import {
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { ListPlus, Loader2, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { localDayDeadlineIso } from '@/lib/tasks/dates';
import type {
  TaskDraft,
  TaskPriority,
} from '@/lib/tasks/types';

type DuePreset = 'today' | 'tomorrow' | 'none';

interface TaskQuickAddProps {
  defaultDue: DuePreset;
  currentUserId: string | null;
  fixedContactId?: string;
  onCreate: (draft: TaskDraft) => Promise<void>;
  onOpenEditor: (initial: Partial<TaskDraft>) => void;
}

function dueForPreset(preset: DuePreset): string | null {
  if (preset === 'today') return localDayDeadlineIso(0);
  if (preset === 'tomorrow') return localDayDeadlineIso(1);
  return null;
}

export function TaskQuickAdd({
  defaultDue,
  currentUserId,
  fixedContactId,
  onCreate,
  onOpenEditor,
}: TaskQuickAddProps) {
  const t = useTranslations('Tasks');
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [duePreset, setDuePreset] = useState<DuePreset>(defaultDue);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function baseDraft(): TaskDraft {
    return {
      title: title.trim(),
      priority,
      due_at: dueForPreset(duePreset),
      assigned_to: currentUserId,
      contact_id: fixedContactId ?? null,
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    setError('');
    try {
      await onCreate(baseDraft());
      setTitle('');
      setPriority('normal');
      setDuePreset(defaultDue);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t('states.saveError'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="task-quick-add-title"
      className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4"
    >
      <h2 id="task-quick-add-title" className="sr-only">
        {t('quickAdd.title')}
      </h2>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="task-quick-title" className="sr-only">
            {t('quickAdd.inputLabel')}
          </Label>
          <Input
            ref={inputRef}
            id="task-quick-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('quickAdd.placeholder')}
            maxLength={200}
            autoComplete="off"
            className="h-10"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex">
          <div>
            <Label htmlFor="task-quick-due" className="sr-only">
              {t('editor.dueLabel')}
            </Label>
            <select
              id="task-quick-due"
              value={duePreset}
              onChange={(event) =>
                setDuePreset(event.target.value as DuePreset)
              }
              className="h-10 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-auto"
            >
              <option value="today">{t('quickAdd.today')}</option>
              <option value="tomorrow">{t('quickAdd.tomorrow')}</option>
              <option value="none">{t('quickAdd.noDate')}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="task-quick-priority" className="sr-only">
              {t('editor.priorityLabel')}
            </Label>
            <select
              id="task-quick-priority"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as TaskPriority)
              }
              className="h-10 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-auto"
            >
              <option value="normal">{t('priority.normal')}</option>
              <option value="high">{t('priority.high')}</option>
              <option value="urgent">{t('priority.urgent')}</option>
              <option value="low">{t('priority.low')}</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-10 flex-1 sm:flex-none"
            onClick={() => {
              onOpenEditor({
                ...baseDraft(),
                title: title.trim(),
              });
              setTitle('');
            }}
          >
            <SlidersHorizontal />
            <span className="sm:sr-only">{t('quickAdd.moreOptions')}</span>
          </Button>
          <Button
            type="submit"
            className="h-10 flex-1 sm:flex-none"
            disabled={saving || !title.trim()}
          >
            {saving ? <Loader2 className="animate-spin" /> : <ListPlus />}
            {saving ? t('quickAdd.adding') : t('quickAdd.add')}
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
