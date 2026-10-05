import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import {
  browserActionSchema,
  verifiedActionCachePayloadSchema,
  observeDiagnosticOperation,
  ZhiYunError,
  type AnalysisResult,
  type BrowserActionCacheContext,
  type BrowserSettings,
  type DiagnosticObserver,
  type DiagnosticStep,
  type RequestSettings,
  type ValidatedCacheEntry,
  type ValidatedCacheKey,
} from '@zhiyun/shared';
import {
  actionHasProof,
  executeBrowserAction,
  type BrowserActionExecutor,
} from './action-execution.js';

type Result = NonNullable<AnalysisResult['cache']>;
export const ACTION_CACHE_VERSIONS = {
  prompt: 'browser-selector-repair-v1',
  tools: 'verified-actions-v1',
} as const;
const attributes = [
  'id',
  'class',
  'role',
  'name',
  'type',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
];

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}
export const actionCacheDigest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');

function safeSelector(value: string): boolean {
  if (value.length > 1024 || /[\\<`]/.test(value)) return false;
  const literal = '[\\p{L}\\p{N}_ .:#/\\-]{1,128}';
  const structural = new RegExp(
    `\\[\\s*(?:${attributes.join('|')})\\s*[~|^$*]?=\\s*(?:"${literal}"|'${literal}'|[\\p{L}\\p{N}_-]+)\\s*(?:[is]\\s*)?\\]`,
    'giu',
  );
  return (
    !/["'=]/.test(value.replace(structural, '[structure]')) &&
    !/:contains|:has-text|text\s*\(|contains\s*\(/i.test(value)
  );
}

function metadataValid(entry: ValidatedCacheEntry, owner: string): boolean {
  const key: ValidatedCacheKey = {
    kind: entry.kind,
    scopeHash: entry.scopeHash,
    sessionHash: entry.sessionHash,
    ruleHash: entry.ruleHash,
    configurationHash: entry.configurationHash,
    providerHash: entry.providerHash,
    promptHash: entry.promptHash,
    actionHash: entry.actionHash,
    structureHash: entry.structureHash,
    keyHash: entry.keyHash,
  };
  return (
    entry.kind === 'action' &&
    entry.ownerScopeHash === owner &&
    Object.entries(key)
      .filter(([name]) => name.endsWith('Hash'))
      .every(([, value]) => /^[a-f0-9]{64}$/.test(value)) &&
    /^[a-f0-9]{64}$/.test(entry.payloadHash) &&
    [entry.createdAt, entry.expiresAt, entry.hitCount].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    entry.expiresAt > entry.createdAt &&
    entry.expiresAt - entry.createdAt <= 7 * 86_400_000 &&
    entry.keyHash === actionCacheDigest({ ...key, keyHash: undefined })
  );
}

function invalidation(
  entry: ValidatedCacheEntry,
  key: ValidatedCacheKey,
  now: number,
): Result['reason'] {
  if (entry.sessionHash !== key.sessionHash) return 'session_changed';
  if (entry.ruleHash !== key.ruleHash) return 'rule_changed';
  if (entry.providerHash !== key.providerHash) return 'provider_changed';
  if (entry.promptHash !== key.promptHash) return 'prompt_changed';
  if (entry.actionHash !== key.actionHash || entry.configurationHash !== key.configurationHash)
    return 'configuration_changed';
  if (entry.expiresAt <= now) return 'expired';
  if (entry.structureHash !== key.structureHash) return 'structure_changed';
  return entry.keyHash === key.keyHash ? 'matched' : 'corrupt';
}

async function snapshot(page: Page) {
  return page.evaluate((structuralAttributes) => {
    const shape: unknown[] = [];
    const candidates: Array<{ selector: string; tag: string; role: string | null }> = [];
    const secrets: string[] = [];
    let bytes = 0;
    let exceeded = false;
    const text = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    let textBytes = 0;
    while (text.nextNode()) {
      const value = text.currentNode.textContent ?? '';
      textBytes += value.length;
      if (textBytes > 1_048_576) {
        exceeded = true;
        break;
      }
      for (const match of value.matchAll(/Bearer\s+([A-Za-z0-9._~+/-]+=*)/gi))
        if (match[1]) secrets.push(match[1]);
    }
    function pathFor(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && parts.length <= 64) {
        const tag = current.tagName.toLowerCase();
        const siblings: Element[] = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              (sibling) => sibling.tagName === current!.tagName,
            )
          : [current];
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }
    function visit(element: Element, depth: number): void {
      if (shape.length >= 20_000 || depth > 64 || bytes > 1_048_576) {
        exceeded = true;
        return;
      }
      const attrs = Array.from(element.attributes)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((attribute) => {
          if (
            /token|secret|password|cookie|auth|credential|api.?key/i.test(attribute.name) &&
            attribute.value
          )
            secrets.push(attribute.value);
          const value = structuralAttributes.includes(attribute.name) ? attribute.value : null;
          bytes += attribute.name.length + (value?.length ?? 0);
          return [attribute.name, value];
        });
      shape.push([depth, element.tagName.toLowerCase(), attrs]);
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        if (element.value) secrets.push(element.value);
      if (
        candidates.length < 100 &&
        (['BUTTON', 'A', 'SELECT', 'INPUT'].includes(element.tagName) ||
          ['button', 'link', 'tab', 'checkbox'].includes(element.getAttribute('role') ?? ''))
      ) {
        const selector = pathFor(element);
        if (
          selector.length <= 1024 &&
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== 'hidden' &&
          !(element instanceof HTMLInputElement && element.type === 'password')
        )
          candidates.push({
            selector,
            tag: element.tagName.toLowerCase(),
            role: ['button', 'link', 'tab', 'checkbox', 'textbox', 'combobox', 'listbox'].includes(
              element.getAttribute('role') ?? '',
            )
              ? element.getAttribute('role')
              : null,
          });
      }
      for (const child of element.children) {
        if (exceeded) break;
        visit(child, depth + 1);
      }
    }
    visit(document.documentElement, 0);
    return { shape, candidates, secrets, exceeded };
  }, attributes);
}

function privateValues(
  request: RequestSettings,
  settings: BrowserSettings,
  url: string,
  storage: unknown,
  pageSecrets: string[],
): string[] {
  const values = [...pageSecrets];
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(request.headers);
  collect(request.cookies.map((cookie) => cookie.value));
  collect(request.proxy);
  const sessionValues = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const state = value as Record<string, unknown>;
    if (Array.isArray(state.cookies))
      for (const cookie of state.cookies)
        if (cookie && typeof cookie === 'object' && 'value' in cookie) collect(cookie.value);
    if (Array.isArray(state.origins))
      for (const origin of state.origins)
        if (
          origin &&
          typeof origin === 'object' &&
          'localStorage' in origin &&
          Array.isArray(origin.localStorage)
        )
          for (const entry of origin.localStorage)
            if (entry && typeof entry === 'object' && 'value' in entry) collect(entry.value);
    for (const [name, child] of Object.entries(state))
      if (!['cookies', 'origins'].includes(name)) collect(child);
  };
  sessionValues(settings.storageState);
  sessionValues(storage);
  for (const [name, value] of Object.entries(request.headers)) {
    if (/authorization/i.test(name)) collect(value.replace(/^(?:Bearer|Basic)\s+/i, ''));
    if (/cookie/i.test(name))
      for (const part of value.split(';')) collect(part.slice(part.indexOf('=') + 1).trim());
  }
  for (const action of settings.actions) if ('value' in action) collect(action.value);
  const source = new URL(url);
  collect(source.username);
  collect(source.password);
  for (const [name, value] of source.searchParams)
    if (
      !/^(?:page|page_?no|page_?size|offset|limit|sort|sort_?by|order|q|query|search|category|lang|locale)$/i.test(
        name,
      )
    )
      collect(value);
  return values;
}

/** Internal analysis context; callers must never serialize its privateValues into an API result. */
export async function browserPageCacheSession(
  page: Page,
  request: RequestSettings,
  settings: BrowserSettings,
) {
  const dom = await snapshot(page);
  const storage = await page.context().storageState();
  const authenticated =
    storage.cookies.length > 0 || storage.origins.some((origin) => origin.localStorage.length > 0);
  return {
    ...(authenticated ? { fingerprint: actionCacheDigest(storage) } : {}),
    privateValues: privateValues(request, settings, page.url(), storage, dom.secrets),
  };
}

/** Cache selectors only. All configured values and validation conditions stay in the current call. */
export class VerifiedBrowserActionCache {
  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      promptVersion?: string;
      toolSchemaVersion?: string;
    } = {},
  ) {}

  async execute(
    page: Page,
    settings: BrowserSettings,
    request: RequestSettings,
    context: BrowserActionCacheContext,
    target: DiagnosticStep['target'] = 'list',
    observer?: DiagnosticObserver,
    signal?: AbortSignal,
    perform?: BrowserActionExecutor,
  ): Promise<Result> {
    signal?.throwIfAborted();
    const now = this.options.now?.() ?? Date.now();
    const identity = context.identity?.();
    const dom = await snapshot(page);
    const storage = await page.context().storageState();
    const ownerScopeHash = actionCacheDigest(context.scope);
    const values = privateValues(request, settings, page.url(), storage, dom.secrets);
    const unsafe = (selector: string) =>
      !safeSelector(selector) || values.some((value) => selector.includes(value));
    const qualified =
      settings.actions.length > 0 &&
      settings.actions.length <= 256 &&
      settings.actions.every(actionHasProof);
    const unknownProvider =
      context.repair &&
      qualified &&
      !dom.exceeded &&
      (!identity ||
        !identity.provider.trim() ||
        !identity.model.trim() ||
        !identity.configuration.trim());
    let writable = Boolean(context.scope && qualified && !dom.exceeded && !unknownProvider);
    const result: Result = {
      status: writable ? 'miss' : 'bypassed',
      reason: !context.scope
        ? 'scope_missing'
        : !qualified
          ? 'validation_failed'
          : dom.exceeded
            ? 'fingerprint_limit'
            : unknownProvider
              ? 'provider_unknown'
              : 'empty',
      hitCount: 0,
      providerCalls: 0,
    };
    const key: ValidatedCacheKey = {
      kind: 'action',
      scopeHash: actionCacheDigest({ ownerScopeHash, target, url: page.url(), version: 1 }),
      sessionHash: actionCacheDigest({
        headers: request.headers,
        cookies: request.cookies,
        proxy: request.proxy,
        storage,
        url: page.url(),
      }),
      ruleHash: actionCacheDigest({
        taskVersion: context.taskVersion,
        ruleVersion: context.ruleVersion,
      }),
      configurationHash: actionCacheDigest({
        request: { ...request, headers: undefined, cookies: undefined, proxy: undefined },
        browser: { ...settings, actions: undefined, storageState: undefined },
        configuration: context.configuration,
      }),
      providerHash: actionCacheDigest(
        identity
          ? {
              provider: identity.provider,
              model: identity.model,
              configuration: identity.configuration,
            }
          : 'deterministic',
      ),
      promptHash: actionCacheDigest([
        this.options.promptVersion ?? ACTION_CACHE_VERSIONS.prompt,
        this.options.toolSchemaVersion ?? ACTION_CACHE_VERSIONS.tools,
        identity?.promptVersion,
        identity?.toolSchemaVersion,
      ]),
      actionHash: actionCacheDigest(settings.actions),
      structureHash: actionCacheDigest(dom.shape),
      keyHash: '',
    };
    key.keyHash = actionCacheDigest({ ...key, keyHash: undefined });
    let generation = 0;
    let previous: ValidatedCacheEntry | undefined;
    let selectors: Array<string | null> = settings.actions.map((action) =>
      'selector' in action ? action.selector : null,
    );
    let cached = false;
    if (writable) {
      try {
        const read = await context.repository.readValidatedCache(key.scopeHash, 'action');
        generation = read.generation;
        if (read.entry) {
          result.reason = metadataValid(read.entry, ownerScopeHash)
            ? invalidation(read.entry, key, now)
            : 'corrupt';
          if (['matched', 'structure_changed'].includes(result.reason)) {
            try {
              if (
                Buffer.byteLength(read.entry.payload) > 32_768 ||
                checksum(read.entry.payload) !== read.entry.payloadHash
              )
                throw new Error('Corrupt');
              const payload = verifiedActionCachePayloadSchema.parse(
                JSON.parse(read.entry.payload),
              );
              if (
                payload.selectors.length !== settings.actions.length ||
                payload.selectors.some(
                  (selector, index) =>
                    'selector' in settings.actions[index]! !== (selector !== null) ||
                    (selector !== null && unsafe(selector)),
                )
              )
                throw new Error('Unsafe');
              selectors = payload.selectors;
              previous = read.entry;
              cached = true;
            } catch {
              result.reason = 'corrupt';
            }
          }
        }
      } catch {
        result.reason = 'storage_unavailable';
        writable = false;
      }
    }
    try {
      for (const [index, original] of settings.actions.entries()) {
        signal?.throwIfAborted();
        let action = browserActionSchema.parse(
          'selector' in original ? { ...original, selector: selectors[index] } : original,
        );
        await observeDiagnosticOperation(
          observer,
          { kind: 'action', target, actionType: original.type },
          async () => {
            // Only repair an absent target, before an action could produce a side effect.
            if (
              ['click', 'press', 'hover'].includes(action.type) &&
              'selector' in action &&
              (await page.locator(action.selector).count()) === 0
            ) {
              if (cached) result.previousValidated = false;
              const goal = 'semanticGoal' in original ? original.semanticGoal : undefined;
              const current = await snapshot(page);
              const currentStorage = await page.context().storageState();
              values.push(
                ...privateValues(request, settings, page.url(), currentStorage, current.secrets),
              );
              const repairable =
                context.repair &&
                qualified &&
                context.scope &&
                !dom.exceeded &&
                !current.exceeded &&
                identity &&
                !unknownProvider &&
                goal &&
                'expectedState' in original &&
                original.expectedState &&
                !values.some((value) => goal.description.includes(value)) &&
                !original.target?.sensitive &&
                result.providerCalls < Math.max(0, Math.min(3, context.maxRepairCalls ?? 1));
              if (!repairable)
                throw new ZhiYunError(
                  'ACTION_STATE_INVALID',
                  'The configured browser action target is absent',
                );
              const candidates = current.candidates.filter(
                (candidate) => !unsafe(candidate.selector),
              );
              if (!candidates.length)
                throw new ZhiYunError(
                  'ACTION_STATE_INVALID',
                  'No eligible browser action target is available',
                );
              result.providerCalls++;
              const repaired = await context.repair!(
                {
                  actionType: action.type as 'click' | 'press' | 'hover',
                  semanticGoal: goal!,
                  candidates,
                },
                signal,
              );
              signal?.throwIfAborted();
              if (
                !candidates.some((candidate) => candidate.selector === repaired.selector) ||
                unsafe(repaired.selector)
              )
                throw new ZhiYunError(
                  'ACTION_STATE_INVALID',
                  'The proposed browser action target is invalid',
                );
              selectors[index] = repaired.selector;
              action = browserActionSchema.parse({ ...original, selector: repaired.selector });
              cached = false;
            }
            await executeBrowserAction(page, action, request.timeoutMs, signal, perform);
          },
          undefined,
          signal,
        );
      }
      if (previous && cached) result.previousValidated = true;
      const finalStorage = await page.context().storageState();
      const finalDom = await snapshot(page);
      const finalValues = privateValues(
        request,
        settings,
        page.url(),
        finalStorage,
        finalDom.secrets,
      );
      if (finalDom.exceeded) {
        writable = false;
        result.reason = 'fingerprint_limit';
      }
      if (
        selectors.some(
          (selector) =>
            selector !== null &&
            (!safeSelector(selector) || finalValues.some((value) => selector.includes(value))),
        )
      ) {
        writable = false;
        result.reason = 'privacy_rejected';
      }
      if (actionCacheDigest(finalStorage) !== actionCacheDigest(storage)) {
        writable = false;
        result.reason = 'session_changed';
      }
      if (actionCacheDigest(context.identity?.()) !== actionCacheDigest(identity)) {
        writable = false;
        result.reason = 'provider_changed';
      }
      if (writable) {
        const payload = JSON.stringify({ version: 1, selectors });
        if (Buffer.byteLength(payload) > 32_768) {
          writable = false;
          result.reason = 'privacy_rejected';
        } else {
          try {
            const accepted =
              cached && previous && result.reason === 'matched'
                ? await context.repository.hitValidatedCache(
                    previous.keyHash,
                    previous.payloadHash,
                    generation,
                  )
                : await context.repository.writeValidatedCache(
                    {
                      ...key,
                      ownerScopeHash,
                      payload,
                      payloadHash: checksum(payload),
                      createdAt: cached && previous ? previous.createdAt : now,
                      expiresAt:
                        cached && previous
                          ? previous.expiresAt
                          : now +
                            Math.min(7 * 86_400_000, Math.max(1, this.options.ttlMs ?? 86_400_000)),
                      hitCount: cached && previous ? previous.hitCount + 1 : 0,
                    },
                    generation,
                  );
            result.status = accepted
              ? cached && result.reason === 'matched'
                ? 'hit'
                : 'stored'
              : 'miss';
            result.hitCount = accepted && cached && previous ? previous.hitCount + 1 : 0;
            if (!accepted) result.reason = 'cleared_during_analysis';
          } catch {
            writable = false;
            result.reason = 'storage_unavailable';
          }
        }
      }
      await context.onResult?.({ ...result });
      return result;
    } catch (error) {
      result.status = 'miss';
      result.reason = 'validation_failed';
      if (cached || previous) result.previousValidated = false;
      await context.onResult?.({ ...result });
      signal?.throwIfAborted();
      throw error;
    }
  }
}
