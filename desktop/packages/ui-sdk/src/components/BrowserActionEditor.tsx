import { productCopy } from '../product-copy.js';
import { useEffect, useState } from 'react';
import {
  browserSettingsSchema,
  type BrowserElementMetadata,
  type BrowserSettings,
  type InspectionElementSelection,
  type InspectionStepResult,
} from '@zhiyun/shared';
import { Button, Input } from './ui.js';

export type BrowserAction = BrowserSettings['actions'][number];
export type BrowserActionTargetRegistry = Readonly<Record<string, BrowserElementMetadata>>;

interface BrowserActionEditorProps {
  value: string;
  onChange(value: string): void;
  onPickSelector?: ((index: number) => void) | undefined;
  onExecuteStep?:
    ((index: number, action: BrowserAction) => Promise<InspectionStepResult>) | undefined;
  knownTargets?: BrowserActionTargetRegistry | undefined;
}

export interface BrowserActionExecutionState {
  status: 'running' | 'succeeded' | 'failed';
  url: string | null;
  error: string | null;
}

export function BrowserActionEditor(props: BrowserActionEditorProps) {
  const [mode, setMode] = useState<'cards' | 'json'>('cards');
  const [actions, setActions] = useState<BrowserAction[]>(() =>
    safeParse(props.value, props.knownTargets),
  );
  const [error, setError] = useState('');
  const [executionStates, setExecutionStates] = useState<
    Record<number, BrowserActionExecutionState>
  >({});
  const runningStepIndex = Object.entries(executionStates).find(
    ([, state]) => state.status === 'running',
  )?.[0];

  useEffect(() => {
    try {
      setActions(parseBrowserActions(props.value, props.knownTargets));
      setError('');
    } catch (reason) {
      if (mode === 'json') setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [props.value, props.knownTargets, mode]);

  const commit = (next: BrowserAction[]) => {
    try {
      const validated = parseBrowserActions(JSON.stringify(next), props.knownTargets);
      setActions(validated);
      setExecutionStates({});
      setError('');
      props.onChange(JSON.stringify(validated, null, 2));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const executeStep = async (index: number, action: BrowserAction) => {
    if (!props.onExecuteStep) return;
    setExecutionStates((current) => ({
      ...current,
      [index]: { status: 'running', url: null, error: null },
    }));
    try {
      const result = await props.onExecuteStep(index, action);
      setExecutionStates((current) => ({
        ...current,
        [index]: executionStateFromResult(result),
      }));
    } catch (reason) {
      setExecutionStates((current) => ({
        ...current,
        [index]: {
          status: 'failed',
          url: null,
          error: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    }
  };

  const update = (index: number, action: BrowserAction) => {
    commit(actions.map((item, position) => (position === index ? action : item)));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target]!, next[index]!];
    commit(next);
  };

  const switchMode = (nextMode: 'cards' | 'json') => {
    if (nextMode === 'cards') {
      try {
        setActions(parseBrowserActions(props.value, props.knownTargets));
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
    }
    setMode(nextMode);
  };

  return (
    <section className="browser-action-editor full" aria-label={productCopy('浏览器动作')}>
      <div className="section-heading compact">
        <div>
          <span className="field-label">{productCopy('浏览器动作')}</span>
          <p>
            {productCopy(
              '按顺序执行点击、填写、等待和滚动；登录密码请使用安全 Login Session 或 CredentialStore。',
            )}
          </p>
        </div>
        <div className="segmented-control" aria-label={productCopy('动作编辑模式')}>
          <button
            type="button"
            className={mode === 'cards' ? 'active' : ''}
            onClick={() => switchMode('cards')}
          >
            {productCopy('卡片')}
          </button>
          <button
            type="button"
            className={mode === 'json' ? 'active' : ''}
            onClick={() => switchMode('json')}
          >
            {productCopy('高级 JSON')}
          </button>
        </div>
      </div>
      {mode === 'json' ? (
        <label>
          <span>{productCopy('浏览器操作 JSON')}</span>
          <textarea
            rows={9}
            value={props.value}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
      ) : (
        <div className="browser-action-list">
          {actions.map((action, index) => {
            const execution = executionStates[index];
            return (
              <article
                className={`browser-action-card${execution ? ` browser-action-card-${execution.status}` : ''}`}
                data-step-status={execution?.status ?? 'idle'}
                key={`${action.type}-${index}`}
              >
                <div className="browser-action-card-heading">
                  <span className="browser-action-order">{index + 1}</span>
                  <label>
                    <span>{productCopy('动作')}</span>
                    <select
                      value={action.type}
                      onChange={(event) => update(index, defaultAction(event.target.value))}
                    >
                      <option value="click">{productCopy('点击')}</option>
                      <option value="fill">{productCopy('填写')}</option>
                      <option value="select">{productCopy('选择下拉项')}</option>
                      <option value="press">{productCopy('按键')}</option>
                      <option value="hover">{productCopy('悬停')}</option>
                      <option value="wait">{productCopy('等待时间')}</option>
                      <option value="waitFor">{productCopy('等待元素')}</option>
                      <option value="scroll">{productCopy('滚动')}</option>
                    </select>
                  </label>
                  <div className="browser-action-card-controls">
                    {props.onExecuteStep && (
                      <Button
                        type="button"
                        className="button-secondary"
                        disabled={runningStepIndex !== undefined}
                        onClick={() => void executeStep(index, action)}
                      >
                        {execution?.status === 'running'
                          ? productCopy('执行中…')
                          : productCopy('执行此步')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      className="button-ghost"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={productCopy('上移第 {{step}} 步', { step: index + 1 })}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      className="button-ghost"
                      disabled={index === actions.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={productCopy('下移第 {{step}} 步', { step: index + 1 })}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      className="button-ghost"
                      onClick={() =>
                        commit([
                          ...actions.slice(0, index + 1),
                          action,
                          ...actions.slice(index + 1),
                        ])
                      }
                    >
                      {productCopy('复制')}
                    </Button>
                    <Button
                      type="button"
                      className="button-danger"
                      onClick={() => commit(actions.filter((_, position) => position !== index))}
                    >
                      {productCopy('删除')}
                    </Button>
                  </div>
                </div>
                <ActionFields
                  action={action}
                  knownTarget={
                    'selector' in action ? props.knownTargets?.[action.selector] : undefined
                  }
                  onChange={(next) => update(index, next)}
                  onPickSelector={
                    props.onPickSelector ? () => props.onPickSelector!(index) : undefined
                  }
                />
                {execution && (
                  <div
                    className={`browser-action-step-status browser-action-step-status-${execution.status}`}
                    role="status"
                  >
                    <strong>{executionStatusLabel(execution.status)}</strong>
                    {execution.error && <span>{execution.error}</span>}
                    {execution.url && <small>{execution.url}</small>}
                  </div>
                )}
              </article>
            );
          })}
          {actions.length === 0 && (
            <div className="empty-small">{productCopy('尚无动作。页面会直接进入采集规则。')}</div>
          )}
          <Button
            type="button"
            className="button-secondary"
            onClick={() => commit([...actions, defaultAction('click')])}
          >
            {productCopy('＋ 添加动作')}
          </Button>
        </div>
      )}
      {error && <div className="notice notice-error">{error}</div>}
      <div className="notice browser-action-security">
        {productCopy(
          '禁止在“填写”动作中保存密码、Cookie 或 Token；需要登录时请使用安全 Login Session 或 CredentialStore。',
        )}
      </div>
    </section>
  );
}

export function executionStateFromResult(
  result: InspectionStepResult,
): BrowserActionExecutionState {
  return { status: result.status, url: result.url, error: result.error };
}

function executionStatusLabel(status: BrowserActionExecutionState['status']): string {
  if (status === 'running') return productCopy('正在执行');
  if (status === 'succeeded') return productCopy('执行成功');
  return productCopy('执行失败');
}

function ActionFields(props: {
  action: BrowserAction;
  knownTarget?: BrowserElementMetadata | undefined;
  onChange(action: BrowserAction): void;
  onPickSelector?: (() => void) | undefined;
}) {
  const action = props.action;
  if (action.type === 'wait') {
    return (
      <label>
        <span>{productCopy('等待毫秒')}</span>
        <Input
          type="number"
          min={0}
          max={60_000}
          value={action.milliseconds}
          onChange={(event) =>
            props.onChange({ ...action, milliseconds: Number(event.target.value) })
          }
        />
      </label>
    );
  }
  if (action.type === 'scroll') {
    return (
      <label>
        <span>{productCopy('滚动次数')}</span>
        <Input
          type="number"
          min={1}
          max={100}
          value={action.count}
          onChange={(event) => props.onChange({ ...action, count: Number(event.target.value) })}
        />
      </label>
    );
  }

  const selector = 'selector' in action ? action.selector : '';
  const probablePassword = isSensitiveFillTarget(action, props.knownTarget);
  return (
    <div className="browser-action-fields">
      <label>
        <span>{productCopy('元素 Selector')}</span>
        <Input
          value={selector}
          onChange={(event) => {
            props.onChange({
              ...action,
              target: undefined,
              selector: event.target.value,
            } as BrowserAction);
          }}
        />
      </label>
      {props.onPickSelector && (
        <Button type="button" className="button-secondary" onClick={props.onPickSelector}>
          {productCopy('从页面选择')}
        </Button>
      )}
      {(action.type === 'fill' || action.type === 'select') && (
        <label>
          <span>{action.type === 'fill' ? productCopy('填写内容') : productCopy('选项值')}</span>
          <Input
            disabled={probablePassword}
            value={action.value}
            onChange={(event) => props.onChange({ ...action, value: event.target.value })}
          />
          {probablePassword && (
            <small className="field-warning">
              {productCopy('疑似密码输入框：此值不会通过保存校验。')}
            </small>
          )}
        </label>
      )}
      {action.type === 'press' && (
        <label>
          <span>{productCopy('按键')}</span>
          <Input
            value={action.key}
            onChange={(event) => props.onChange({ ...action, key: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}

export function parseBrowserActions(
  value: string,
  knownTargets: BrowserActionTargetRegistry = {},
): BrowserAction[] {
  const parsed = JSON.parse(value) as unknown;
  const actions = browserSettingsSchema.parse({
    enabled: true,
    waitUntil: 'domcontentloaded',
    actions: parsed,
  }).actions;
  const hydrated = actions.map((action) => {
    if (!('selector' in action) || action.target) return action;
    const target = knownTargets[action.selector];
    return target ? ({ ...action, target } as BrowserAction) : action;
  });
  const unsafe = hydrated.find(
    (action) => action.type === 'fill' && action.value.length > 0 && isSensitiveFillTarget(action),
  );
  if (unsafe) {
    throw new Error(
      productCopy('禁止在浏览器动作中保存密码；请使用安全 Login Session 或 CredentialStore。'),
    );
  }
  return hydrated;
}

export function isSensitiveFillTarget(
  action: BrowserAction,
  knownTarget?: BrowserElementMetadata,
): boolean {
  return (
    action.type === 'fill' &&
    (action.target?.sensitive === true ||
      knownTarget?.sensitive === true ||
      /password|passwd|pwd|type\s*=\s*["']?password/i.test(action.selector))
  );
}

export function updateActionSelector(
  value: string,
  index: number,
  selected: string | InspectionElementSelection,
): string {
  const actions = parseBrowserActions(value);
  const action = actions[index];
  if (!action || !('selector' in action)) throw new Error(productCopy('这个动作不使用 Selector'));
  const selector = typeof selected === 'string' ? selected : selected.selector;
  const target = typeof selected === 'string' ? undefined : selected.metadata;
  const next = actions.map((item, position) => {
    if (position !== index) return item;
    if (!('selector' in item)) return item;
    return {
      ...item,
      target: undefined,
      selector,
      ...(target ? { target } : {}),
    } as BrowserAction;
  });
  return JSON.stringify(
    parseBrowserActions(JSON.stringify(next), target ? { [selector]: target } : {}),
    null,
    2,
  );
}

function safeParse(value: string, knownTargets?: BrowserActionTargetRegistry): BrowserAction[] {
  try {
    return parseBrowserActions(value, knownTargets);
  } catch {
    return [];
  }
}

function defaultAction(type: string): BrowserAction {
  switch (type) {
    case 'fill':
      return { type: 'fill', selector: 'input', value: '' };
    case 'select':
      return { type: 'select', selector: 'select', value: '' };
    case 'press':
      return { type: 'press', selector: 'input', key: 'Enter' };
    case 'hover':
      return { type: 'hover', selector: 'button' };
    case 'wait':
      return { type: 'wait', milliseconds: 500 };
    case 'waitFor':
      return { type: 'waitFor', selector: '.loaded' };
    case 'scroll':
      return { type: 'scroll', count: 1 };
    default:
      return { type: 'click', selector: 'button' };
  }
}
