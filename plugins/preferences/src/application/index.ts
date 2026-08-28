import { preferenceSignalInputSchema, type PreferenceSignalInput } from '@zhiyun/shared';
import type {
  PreferencesRepository,
  PreferencesServiceContract,
  PreferenceSignal,
  PreferenceSignalPage,
  TrendSourceBinding,
} from '../contracts/index.js';

export class PreferencesService implements PreferencesServiceContract {
  constructor(private readonly repository: PreferencesRepository) {}

  listSignals(cursor?: string, limit?: number): Promise<PreferenceSignalPage> {
    return this.repository.listPreferenceSignals(cursor, limit);
  }

  setSignal(input: PreferenceSignalInput): Promise<PreferenceSignal> {
    const validated = preferenceSignalInputSchema.parse(input);
    const targetKey = [
      validated.content.platform,
      validated.content.contentType,
      validated.content.externalId,
    ].join(':');
    return this.repository.upsertPreferenceSignal({ ...validated, targetKey });
  }

  deleteSignal(id: string): Promise<boolean> {
    return this.repository.deletePreferenceSignal(id);
  }

  clearSignals(): Promise<number> {
    return this.repository.clearPreferenceSignals();
  }

  listTrendSources(): Promise<TrendSourceBinding[]> {
    return this.repository.listTrendSourceBindings();
  }

  clearCollectionTaskReference(taskId: string): Promise<number> {
    return this.repository.clearTaskReference(taskId);
  }
}
