import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import type { CollectionDraftPatch } from '@zhiyun/shared';
import { normalizeCrawlPlan } from '@zhiyun/shared';
import {
  applyTemplateParameters,
  templateParameterDefaults,
  missingTemplateParameters,
} from '../task-template.js';
import { Button, ErrorNotice } from './ui.js';
import { Dialog, Field, Select } from './experience.js';
import { SchemaForm } from './SchemaForm.js';

export function DraftTemplates({ onApply }: { onApply: (patch: CollectionDraftPatch) => void }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => runtimeClient.listTaskTemplates(),
  });
  const [id, setId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const selected = templates.data?.find((template) => template.id === id);
  return (
    <details>
      <summary>{zh ? '专业模板（全部八类）' : 'Professional templates (all eight types)'}</summary>
      <ErrorNotice message={templates.error?.message} onRetry={() => void templates.refetch()} />
      <Select
        aria-label={zh ? '专业模板' : 'Professional template'}
        value={id}
        onChange={(e) => {
          setId(e.target.value);
          const template = templates.data?.find((item) => item.id === e.target.value);
          setValues(template ? templateParameterDefaults(template) : {});
        }}
      >
        <option value="">{zh ? '选择模板' : 'Choose template'}</option>
        {templates.data?.map((template) => (
          <option key={template.id} value={template.id}>
            {zh ? template.name : template.id.replaceAll('-', ' ')}
          </option>
        ))}
      </Select>
      {selected && (
        <>
          <SchemaForm
            schema={{
              type: 'object',
              required: selected.parameters
                .filter((param) => param.required)
                .map((param) => param.key),
              properties: Object.fromEntries(
                selected.parameters.map((param) => [
                  param.key,
                  {
                    type: 'string',
                    title: zh ? param.label : param.key.replace(/([A-Z])/g, ' $1'),
                    default: param.defaultValue,
                  },
                ]),
              ),
            }}
            value={values}
            onChange={(next) =>
              setValues(
                Object.fromEntries(
                  Object.entries(next).map(([key, value]) => [key, String(value ?? '')]),
                ),
              )
            }
          />
          <Button
            className="button-secondary"
            disabled={missingTemplateParameters(selected, values).length > 0}
            onClick={() =>
              onApply({
                mode: 'template',
                definition: normalizeCrawlPlan(applyTemplateParameters(selected, values)),
                task: selected.taskDefaults,
              })
            }
          >
            {zh ? '应用到当前草稿' : 'Apply to current draft'}
          </Button>
        </>
      )}
    </details>
  );
}

export function DraftInspection({
  flush,
  fields,
  onSelect,
}: {
  flush: () => Promise<{ id: string } | null>;
  fields: string[];
  onSelect: (field: string, selector: string) => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [session, setSession] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<{
    image: string;
    width: number;
    height: number;
  } | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      if (session) void runtimeClient.closeInspectionSession(session).catch(() => undefined);
    },
    [session],
  );
  const action = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (id: string) =>
    setScreenshot(await runtimeClient.getInspectionScreenshot(id));
  return (
    <>
      <Button
        className="button-secondary"
        disabled={busy}
        onClick={() =>
          void action(async () => {
            const draft = await flush();
            if (!draft) return;
            const value = await runtimeClient.createDraftInspectionSession(draft.id);
            setSession(value.id);
            await refresh(value.id);
          })
        }
      >
        {zh ? '打开页面点选字段' : 'Open page to select fields'}
      </Button>
      <ErrorNotice message={error} />
      <Dialog
        open={Boolean(session)}
        title={zh ? '点选页面元素' : 'Select a page element'}
        onClose={() => {
          setSession(null);
          setScreenshot(null);
        }}
      >
        <Field label={zh ? '应用到' : 'Apply to'}>
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{zh ? '记录容器' : 'Record container'}</option>
            {fields.map((field) => (
              <option key={field}>{field}</option>
            ))}
          </Select>
        </Field>
        <p>
          {zh
            ? '点击图片中的元素以更新规则。键盘用户可直接在字段表中输入选择器。'
            : 'Click an element in the image to update its rule. Keyboard users can edit selectors directly in the field table.'}
        </p>
        <div className="heading-actions">
          {[-600, 600].map((delta) => (
            <Button
              key={delta}
              className="button-secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await runtimeClient.interactWithInspection(session!, {
                    type: 'scroll',
                    deltaY: delta,
                  });
                  await refresh(session!);
                })
              }
            >
              {delta < 0 ? (zh ? '向上滚动' : 'Scroll up') : zh ? '向下滚动' : 'Scroll down'}
            </Button>
          ))}
        </div>
        {screenshot && (
          <img
            style={{ width: '100%', cursor: 'crosshair' }}
            src={`data:image/png;base64,${screenshot.image}`}
            alt={zh ? '目标网页预览' : 'Target page preview'}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const point = {
                x: ((event.clientX - bounds.left) * screenshot.width) / bounds.width,
                y: ((event.clientY - bounds.top) * screenshot.height) / bounds.height,
              };
              void action(async () => {
                const selected = await runtimeClient.selectInspectionElement(session!, point);
                if (selected.metadata.sensitive)
                  throw new Error(
                    zh
                      ? '敏感输入框不能作为采集字段'
                      : 'Sensitive inputs cannot be collection fields',
                  );
                onSelect(target, selected.selector);
                setSession(null);
              });
            }}
          />
        )}
        <ErrorNotice message={error} />
      </Dialog>
    </>
  );
}
