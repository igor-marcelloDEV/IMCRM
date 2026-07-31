export type TaskStatus = 'open' | 'completed' | 'canceled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskPerson {
  user_id: string;
  full_name: string | null;
  avatar_url: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  created_by: string | null;
  contact_id: string | null;
  deal_id: string | null;
  order_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  assignee: TaskPerson | null;
  creator: TaskPerson | null;
}

export interface TaskActivity {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  task_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  order_id: string | null;
  conversation_id: string | null;
  created_at: string;
  actor: TaskPerson | null;
}

export interface TaskDraft {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  assigned_to?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  order_id?: string | null;
  conversation_id?: string | null;
}

export interface TaskMemberOption extends TaskPerson {
  email?: string | null;
}

export interface TaskContactOption {
  id: string;
  name: string | null;
  phone: string | null;
}

export interface TaskDealOption {
  id: string;
  title: string;
  contact_id: string | null;
}

export interface TaskResources {
  members: TaskMemberOption[];
  contacts: TaskContactOption[];
  deals: TaskDealOption[];
}

