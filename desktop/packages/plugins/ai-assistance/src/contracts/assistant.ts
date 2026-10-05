import type {
  AssistantAction,
  AssistantConversation,
  AssistantContext,
  AssistantResource,
  CollectionDraft,
  CollectionDraftPatch,
} from '@zhiyun/contracts';
export interface AssistantActor {
  id: string;
  permissions: readonly string[];
}
export interface AssistantResourceView {
  resource: AssistantResource;
  revision: number | null;
  summary: Record<string, unknown>;
}
export interface AssistantBusinessPort {
  read(resource: AssistantResource): Promise<AssistantResourceView>;
  getDraft(id: string): Promise<CollectionDraft | null>;
  createExample(id: string): Promise<CollectionDraft>;
  draftForTask(taskId: string, id: string): Promise<CollectionDraft>;
  patchDraft(id: string, revision: number, patch: CollectionDraftPatch): Promise<CollectionDraft>;
  previewDraft(id: string, revision: number, signal: AbortSignal): Promise<CollectionDraft>;
  execute(action: AssistantAction, actor: AssistantActor): Promise<Record<string, unknown>>;
  recoverAction(action: AssistantAction): Promise<Record<string, unknown> | null>;
  prepareRepair(
    resource: AssistantResource,
    signal: AbortSignal,
  ): Promise<{
    resource: AssistantResource;
    revision: number;
    parameters: Record<string, unknown>;
    summary: string;
    preview: {
      records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
      createdAt: string;
    };
  }>;
  verifyLesson(
    conversation: AssistantConversation,
    activity: string,
    reference?: string,
  ): Promise<string | null>;
  resolveActor(actor: AssistantActor): Promise<AssistantActor>;
  controlledLogin: boolean;
  recordLearning?(
    conversationId: string,
    type: 'lesson_started' | 'lesson_completed' | 'example_started' | 'example_completed',
    reference: string,
  ): Promise<void>;
  recordAttempt?(conversationId: string, context: AssistantContext): Promise<void>;
}
