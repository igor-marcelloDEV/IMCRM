'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileText, ImageIcon, Link2, Loader2, Paperclip, Send, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import type { TaskActivity } from '@/lib/tasks/types';

const ATTACHMENT_BUCKET = 'flow-media';
const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf';

interface ActivityMetadata {
  link_url?: string | null;
  attachment_url?: string | null;
  attachment_type?: 'image' | 'document' | null;
}

/**
 * "Andamentos" — a manual, timestamped progress log inside a task,
 * with an optional link or file (image/PDF) attached. Backed by the
 * same `activities` table and `append_activity` RPC as every other
 * timeline in the app (order lifecycle, task completion) — this is
 * just another event_type ('task.progress_update'), not new schema.
 */
export function TaskProgressLog({ taskId }: { taskId: string }) {
  const t = useTranslations('Tasks.progressLog');
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [attachment, setAttachment] = useState<{ url: string; type: 'image' | 'document'; name: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/activities?task_id=${taskId}&limit=50`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setActivities(
          ((data.activities ?? []) as TaskActivity[]).filter(
            (a) => a.event_type === 'task.progress_update',
          ),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleFile = useCallback(
    async (file: File) => {
      const isImage = file.type.startsWith('image/');
      const kind: 'image' | 'document' = isImage ? 'image' : 'document';
      const limit = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > limit) {
        toast.error(t('toastFileTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }));
        return;
      }
      setUploading(true);
      try {
        const { url } = await uploadAccountMedia(ATTACHMENT_BUCKET, file);
        setAttachment({ url, type: kind, name: file.name });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('toastUploadFailed'));
      } finally {
        setUploading(false);
      }
    },
    [t],
  );

  async function submit() {
    if (!text.trim()) {
      toast.error(t('toastEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: text.trim(),
          link_url: linkUrl.trim() || null,
          attachment_url: attachment?.url ?? null,
          attachment_type: attachment?.type ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastFailed'));
        return;
      }
      setText('');
      setLinkUrl('');
      setAttachment(null);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : activities.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {activities.map((event) => {
            const meta = (event.metadata ?? {}) as ActivityMetadata;
            return (
              <li key={event.id} className="rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
                <p className="whitespace-pre-wrap text-foreground">{event.summary}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span>
                    {event.actor?.full_name ?? t('unknownActor')} · {new Date(event.created_at).toLocaleString()}
                  </span>
                  {meta.link_url && (
                    <a
                      href={meta.link_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <Link2 className="h-3 w-3" />
                      {t('viewLink')}
                    </a>
                  )}
                  {meta.attachment_url && (
                    <a
                      href={meta.attachment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {meta.attachment_type === 'image' ? (
                        <ImageIcon className="h-3 w-3" />
                      ) : (
                        <FileText className="h-3 w-3" />
                      )}
                      {t('viewAttachment')}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-card p-2.5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('placeholder')}
          maxLength={500}
          className="min-h-16 resize-y text-sm"
        />
        <Input
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder={t('linkPlaceholder')}
          type="url"
          className="h-8 text-xs"
        />

        {attachment ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs">
            {attachment.type === 'image' ? (
              <ImageIcon className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            )}
            <span className="min-w-0 flex-1 truncate text-foreground">{attachment.name}</span>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('removeAttachment')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="h-8 gap-1.5 text-xs"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            {uploading ? t('uploading') : t('attachFile')}
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />

        <Button
          type="button"
          size="sm"
          className="h-8 w-full gap-1.5 text-xs"
          disabled={submitting || !text.trim()}
          onClick={submit}
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {t('submit')}
        </Button>
      </div>
    </div>
  );
}
