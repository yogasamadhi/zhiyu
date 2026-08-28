import { Fragment, useEffect, useState } from 'react';
import { runtimeClient, type DesktopDiagnostics } from '@zhiyun/client';
import { Button, Card, ErrorNotice } from '../components/ui.js';

export function SettingsPage() {
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void runtimeClient
      .getDesktopDiagnostics()
      .then(setDiagnostics)
      .catch((reason: Error) => setError(reason.message));
  }, []);
  const backup = async () => {
    try {
      const result = await runtimeClient.createDesktopBackup();
      setMessage(result.saved ? '备份已保存' : '已取消保存');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const restore = async () => {
    if (!window.confirm('恢复会替换当前桌面数据库，并重启 Runtime。继续吗？')) return;
    try {
      const result = await runtimeClient.restoreDesktopBackup();
      setMessage(result.canceled ? '恢复已取消' : '备份已验证，Runtime 正在重启');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Desktop 设置</h1>
          <p>诊断、数据备份与恢复</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <div className="notice notice-success">{message}</div>}
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
        <h2>SQLite 数据</h2>
        <p>备份使用 SQLite 在线 Backup API；恢复文件会先做完整性校验，并保留恢复前副本。</p>
        <div className="row-actions">
          <Button onClick={() => void backup()}>一键备份</Button>
          <Button className="button-danger" onClick={() => void restore()}>
            从备份恢复
          </Button>
        </div>
      </Card>
    </>
  );
}
