import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorNotice } from './ui.js';
import { Dialog, Menu } from './experience.js';

export function ConfirmAction({
  label,
  description,
  disabled = false,
  onConfirm,
}: {
  label: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const execute = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu label={t('ux.more')}>
        <Button className="button-ghost" disabled={disabled || busy} onClick={() => setOpen(true)}>
          {label}
        </Button>
      </Menu>
      <Dialog
        open={open}
        title={label}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      >
        <p>{description}</p>
        <ErrorNotice message={error} />
        <div className="heading-actions">
          <Button className="button-secondary" disabled={busy} onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button className="button-danger" disabled={busy} onClick={() => void execute()}>
            {busy ? t('loading') : label}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
