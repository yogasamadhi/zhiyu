import { Fragment, useEffect, useState } from 'react';
import { runtimeClient, type DesktopDiagnostics } from '@zhiyun/client';
import { Card, ErrorNotice } from '../components/ui.js';

export function SettingsPage() {
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void runtimeClient
      .getDesktopDiagnostics()
      .then(setDiagnostics)
      .catch((reason: Error) => setError(reason.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Runtime 设置</h1>
          <p>运行状态与架构诊断</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <Card>
        <h2>Runtime</h2>
        {diagnostics ? (
          <dl className="diagnostics-grid">
            <dt>版本</dt>
            <dd>{diagnostics.runtime.version}</dd>
            <dt>Generation</dt>
            <dd>{diagnostics.runtime.generation}</dd>
            <dt>Runtime ID</dt>
            <dd>
              <code>{diagnostics.runtime.runtimeId}</code>
            </dd>
            <dt>Chromium 资源</dt>
            <dd>{diagnostics.browserResources ?? '未检测到'}</dd>
            {Object.entries(diagnostics.database).map(([key, value]) => (
              <Fragment key={key}>
                <dt>{key}</dt>
                <dd>{String(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <div className="empty-small">Desktop Runtime 诊断不可用</div>
        )}
      </Card>
      <Card>
        <h2>1.0 数据策略</h2>
        <p>
          ZhiYun 1.0 使用全新 Schema。首次检测到明确的 0.x
          数据时会自动清空；本版本不提供旧数据备份、恢复或导入工具。
        </p>
      </Card>
    </>
  );
}
