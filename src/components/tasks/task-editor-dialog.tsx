'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
  localDayDeadlineIso,
} from '@/lib/tasks/dates';
import type {
  Task,
  TaskDraft,
  TaskPriority,
  TaskResources,
} from '@/lib/tasks/types';
import { TaskProgressLog } from '@/components/tasks/task-progress-log';

const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

interface TaskEditorDialogProps {
  task?: Task | null;
  initial?: Partial<TaskDraft>;
  resources: TaskResources;
  resourcesLoading: boolean;
  resourcesError: boolean;
  fixedContact?: { id: string; label: string } | null;
  /** Ties the task back to the conversation it came from, so
   *  TaskRow can offer a "reply on WhatsApp" link straight back to
   *  it once the task is done. Not user-editable — set once, from
   *  wherever the task was created (e.g. MessageThread's "Nova
   *  tarefa" button), same shape as fixedContact. */
  fixedConversationId?: string | null;
  onClose: () => void;
  onSave: (draft: TaskDraft) => Promise<void>;
}

export function TaskEditorDialog({
  task,
  initial,
  resources,
  resourcesLoading,
  resourcesError,
  fixedContact,
  fixedConversationId,
  onClose,
  onSave,
}: TaskEditorDialogProps) {
  const t = useTranslations('Tasks');
  const [title, setTitle] = useState(task?.title ?? initial?.title ?? '');
  const [description, setDescription] = useState(
    task?.description ?? initial?.description ?? '',
  );
  const [priority, setPriority] = useState<TaskPriority>(
    task?.priority ?? initial?.priority ?? 'normal',
  );
  const [dueInput, setDueInput] = useState(
    isoToLocalDateTimeInput(task?.due_at ?? initial?.due_at ?? null),
  );
  const [assignedTo, setAssignedTo] = useState(
    task?.assigned_to ?? initial?.assigned_to ?? '',
  );
  const [contactId, setContactId] = useState(
    fixedContact?.id ?? task?.contact_id ?? initial?.contact_id ?? '',
  );
  const [dealId, setDealId] = useState(
    task?.deal_id ?? initial?.deal_id ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const availableDeals = useMemo(() => {
    if (!contactId) return resources.deals;
    return resources.deals.filter(
      (deal) => !deal.contact_id || deal.contact_id === contactId,
    );
  }, [contactId, resources.deals]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;

    setSaving(true);
    setError('');
    try {
      await onSave({
        title: normalizedTitle,
        description: description.trim() || null,
        priority,
        due_at: localDateTimeInputToIso(dueInput),
        assigned_to: assignedTo || null,
        contact_id: (fixedContact?.id ?? contactId) || null,
        deal_id: dealId || null,
        conversation_id: fixedConversationId ?? task?.conversation_id ?? initial?.conversation_id ?? null,
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('states.saveError'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {task ? t('editor.editTitle') : t('editor.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {task ? t('editor.editDescription') : t('editor.createDescription')}
          </DialogDescription>
        </DialogHeader>

        <form id="task-editor-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="task-editor-title">{t('editor.titleLabel')}</Label>
            <Input
              id="task-editor-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('editor.titlePlaceholder')}
              maxLength={200}
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-editor-description">
              {t('editor.descriptionLabel')}
            </Label>
            <Textarea
              id="task-editor-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('editor.descriptionPlaceholder')}
              maxLength={2000}
              className="min-h-20 resize-y"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-editor-priority">
                {t('editor.priorityLabel')}
              </Label>
              <select
                id="task-editor-priority"
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as TaskPriority)
                }
                className={SELECT_CLASS}
              >
                <option value="low">{t('priority.low')}</option>
                <option value="normal">{t('priority.normal')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="urgent">{t('priority.urgent')}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-editor-due">{t('editor.dueLabel')}</Label>
              <Input
                id="task-editor-due"
                type="datetime-local"
                value={dueInput}
                onChange={(event) => setDueInput(event.target.value)}
              />
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    setDueInput(
                      isoToLocalDateTimeInput(localDayDeadlineIso(0)),
                    )
                  }
                >
                  {t('quickAdd.today')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    setDueInput(
                      isoToLocalDateTimeInput(localDayDeadlineIso(1)),
                    )
                  }
                >
                  {t('quickAdd.tomorrow')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setDueInput('')}
                >
                  {t('quickAdd.noDate')}
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="task-editor-assignee">
                {t('editor.assigneeLabel')}
              </Label>
              <select
                id="task-editor-assignee"
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
                disabled={resourcesLoading}
                className={SELECT_CLASS}
              >
                <option value="">{t('editor.unassigned')}</option>
                {resources.members.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.full_name || member.email || t('row.unknownPerson')}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-editor-contact">
                {t('editor.contactLabel')}
              </Label>
              {fixedContact ? (
                <Input
                  id="task-editor-contact"
                  value={fixedContact.label}
                  disabled
                />
              ) : (
                <select
                  id="task-editor-contact"
                  value={contactId}
                  onChange={(event) => {
                    setContactId(event.target.value);
                    setDealId('');
                  }}
                  disabled={resourcesLoading}
                  className={SELECT_CLASS}
                >
                  <option value="">{t('editor.noContact')}</option>
                  {resources.contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name || contact.phone || t('row.unknownContact')}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-editor-deal">{t('editor.dealLabel')}</Label>
            <select
              id="task-editor-deal"
              value={dealId}
              onChange={(event) => setDealId(event.target.value)}
              disabled={resourcesLoading}
              className={SELECT_CLASS}
            >
              <option value="">{t('editor.noDeal')}</option>
              {availableDeals.map((deal) => (
                <option key={deal.id} value={deal.id}>
                  {deal.title}
                </option>
              ))}
            </select>
          </div>

          {resourcesError ? (
            <p className="text-xs text-amber-600 dark:text-amber-300">
              {t('editor.resourcesWarning')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>

        {task ? (
          <div className="space-y-1.5 border-t border-border pt-4">
            <Label>{t('progressLog.sectionTitle')}</Label>
            <TaskProgressLog taskId={task.id} />
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('actions.close')}
          </Button>
          <Button
            type="submit"
            form="task-editor-form"
            disabled={saving || !title.trim()}
          >
            {saving ? (
              <Loader2 className="animate-spin" />
            ) : (
              <CalendarClock />
            )}
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
