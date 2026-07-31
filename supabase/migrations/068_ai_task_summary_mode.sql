-- ============================================================
-- 068_ai_task_summary_mode.sql
--
-- New AI usage mode: 'task_summary' — the "Nova tarefa" button in the
-- inbox (src/components/inbox/message-thread.tsx) analyzes the
-- conversation and writes the task description itself ("what needs
-- to be done with this customer"), instead of pasting the customer's
-- last raw message. Same generateReply() plumbing as draft/auto_reply
-- (see src/app/api/ai/task-summary/route.ts), just a third mode value
-- ai_usage_log needs to accept.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'task_summary'));
