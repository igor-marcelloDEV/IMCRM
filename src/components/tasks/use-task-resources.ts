'use client';

import { useCallback, useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';
import type {
  TaskContactOption,
  TaskDealOption,
  TaskMemberOption,
  TaskResources,
} from '@/lib/tasks/types';

const EMPTY_RESOURCES: TaskResources = {
  members: [],
  contacts: [],
  deals: [],
};

export function useTaskResources() {
  const [resources, setResources] = useState<TaskResources>(EMPTY_RESOURCES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    const db = createClient();

    try {
      const [membersResponse, contactsResult, dealsResult] = await Promise.all([
        fetch('/api/account/members', { cache: 'no-store', signal }),
        db
          .from('contacts')
          .select('id, name, phone')
          .order('name')
          .limit(200),
        db
          .from('deals')
          .select('id, title, contact_id')
          .eq('status', 'open')
          .order('title')
          .limit(200),
      ]);

      const memberPayload = membersResponse.ok
        ? ((await membersResponse.json()) as { members?: TaskMemberOption[] })
        : {};
      if (
        !membersResponse.ok ||
        contactsResult.error ||
        dealsResult.error
      ) {
        setError(true);
      }

      setResources({
        members: memberPayload.members ?? [],
        contacts:
          (contactsResult.data as TaskContactOption[] | null) ?? [],
        deals: (dealsResult.data as TaskDealOption[] | null) ?? [],
      });
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
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return { resources, loading, error, reload: load };
}

