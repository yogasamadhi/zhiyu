import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AssistantWorkspace } from '@zhiyun/ui-sdk/components/assistant/AssistantWorkspace';
import { useAssistant } from '@zhiyun/ui-sdk/components/assistant/AssistantProvider';
export function AssistantPage() {
  const assistant = useAssistant();
  const [params, setParams] = useSearchParams();
  const { i18n } = useTranslation();
  const creating = useRef(false);
  const id = params.get('conversation');
  const draft = params.get('draft');
  useEffect(() => {
    if (id && id !== assistant.selectedId) assistant.select(id);
    if (!id && draft && !creating.current) {
      creating.current = true;
      void assistant
        .perform(async () => {
          const value = await assistant.start('collect', { kind: 'draft', id: draft });
          setParams({ conversation: value.conversation.id }, { replace: true });
        })
        .finally(() => {
          creating.current = false;
        });
    }
  }, [id, draft]);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{i18n.language.startsWith('zh') ? '织云助手' : 'ZhiYun assistant'}</h1>
        </div>
      </div>
      <AssistantWorkspace />
    </>
  );
}
