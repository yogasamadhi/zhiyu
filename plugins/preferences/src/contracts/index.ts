import type {
  PreferenceContent,
  PreferencePlatform,
  PreferenceSignal,
  PreferenceSignalInput,
} from '@zhiyun/shared';

export interface TrendSourceBinding {
  key: string;
  platform: PreferencePlatform;
  taskId: string | null;
  enabled: boolean;
  autoRefresh: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceSignalPage {
  items: PreferenceSignal[];
  nextCursor: string | null;
}

export interface PreferencesRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  listTrendSourceBindings(): Promise<TrendSourceBinding[]>;
  getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null>;
  upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding>;
  updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null>;
  clearTaskReference(taskId: string): Promise<number>;
  listPreferenceSignals(cursor?: string, limit?: number): Promise<PreferenceSignalPage>;
  upsertPreferenceSignal(
    input: PreferenceSignalInput & { targetKey: string },
  ): Promise<PreferenceSignal>;
  deletePreferenceSignal(id: string): Promise<boolean>;
  clearPreferenceSignals(): Promise<number>;
}

export interface PreferencesServiceContract {
  listSignals(cursor?: string, limit?: number): Promise<PreferenceSignalPage>;
  setSignal(input: PreferenceSignalInput): Promise<PreferenceSignal>;
  deleteSignal(id: string): Promise<boolean>;
  clearSignals(): Promise<number>;
  listTrendSources(): Promise<TrendSourceBinding[]>;
  clearCollectionTaskReference(taskId: string): Promise<number>;
}

export type { PreferenceContent, PreferencePlatform, PreferenceSignal, PreferenceSignalInput };
