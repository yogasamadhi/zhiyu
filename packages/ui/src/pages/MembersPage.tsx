import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  runtimeClient,
  type IdentityInvitation,
  type IdentityRole,
  type IdentityUser,
} from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { buildWorkspaceTokenLink, invitationStatus } from '../identity-links.js';

const roleOptions: Array<{ value: IdentityRole; label: string }> = [
  { value: 'admin', label: '管理员' },
  { value: 'editor', label: '编辑者' },
  { value: 'viewer', label: '只读' },
];

export function MembersPage() {
  const auth = useWorkspaceAuth();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<IdentityRole>('viewer');
  const [oneTimeLink, setOneTimeLink] = useState<{ title: string; url: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const canManage = auth.permissions.includes('member.manage');
  const members = useQuery({
    queryKey: ['identity', 'members'],
    queryFn: () => runtimeClient.listMembers(),
    enabled: canManage,
  });
  const invitations = useQuery({
    queryKey: ['identity', 'invitations'],
    queryFn: () => runtimeClient.listInvitations(),
    enabled: canManage,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['identity', 'members'] }),
      queryClient.invalidateQueries({ queryKey: ['identity', 'invitations'] }),
    ]);
  };
  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onSuccess: refresh,
    onError: (reason) => reportIdentityError(reason, auth, setError),
  });

  if (!canManage) {
    return (
      <Card>
        <span className="badge badge-danger">权限不足</span>
        <h1>成员管理仅限管理员</h1>
        <p>编辑者和只读成员无法查看邀请、修改角色或生成密码重置链接。</p>
      </Card>
    );
  }

  const createInvitation = async (event: FormEvent) => {
    event.preventDefault();
    await issueInvitation(email, role);
  };

  const issueInvitation = async (
    invitationEmail: string,
    invitationRole: IdentityRole,
    revokeId?: string,
  ) => {
    setError('');
    setNotice('');
    try {
      if (revokeId) await runtimeClient.revokeInvitation(revokeId);
      const result = await runtimeClient.createInvitation({
        email: invitationEmail,
        role: invitationRole,
      });
      setOneTimeLink({
        title: `${result.invitation.email} 的邀请链接`,
        url: buildWorkspaceTokenLink(window.location.origin, 'invitation', result.token),
      });
      if (!revokeId) setEmail('');
      setNotice('邀请已创建。链接只会完整显示这一次，请立即复制。');
      await refresh();
    } catch (reason) {
      reportIdentityError(reason, auth, setError);
    }
  };

  const updateMember = (
    member: IdentityUser,
    input: { role?: IdentityRole; disabled?: boolean },
  ) => {
    setError('');
    setNotice('');
    mutation.mutate(() => runtimeClient.updateMember(member.id, input));
  };

  const createPasswordReset = async (member: IdentityUser) => {
    setError('');
    setNotice('');
    try {
      const result = await runtimeClient.createMemberPasswordReset(member.id);
      setOneTimeLink({
        title: `${member.displayName} 的密码重置链接`,
        url: buildWorkspaceTokenLink(window.location.origin, 'password-reset', result.token),
      });
      setNotice(`重置链接有效至 ${formatDate(result.expiresAt)}，且只能使用一次。`);
    } catch (reason) {
      reportIdentityError(reason, auth, setError);
    }
  };

  const copyOneTimeLink = async () => {
    if (!oneTimeLink) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink.url);
      setNotice('链接已复制到剪贴板。');
    } catch {
      setError('无法自动复制，请手动选中链接复制。');
    }
  };

  const loadError = members.error ?? invitations.error;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Workspace access</span>
          <h1>成员与邀请</h1>
          <p>单工作区固定使用管理员、编辑者和只读三档角色。</p>
        </div>
      </div>
      <ErrorNotice message={error || (loadError ? errorMessage(loadError) : '')} />
      {notice && <div className="notice notice-success">{notice}</div>}
      {oneTimeLink && (
        <Card className="one-time-secret">
          <div>
            <span className="eyebrow">One-time link</span>
            <h2>{oneTimeLink.title}</h2>
            <p>织云只保存 Token 哈希，关闭此提示后无法再次查看同一个链接。</p>
          </div>
          <div className="one-time-link">
            <Input aria-label={oneTimeLink.title} readOnly value={oneTimeLink.url} />
            <Button onClick={() => void copyOneTimeLink()}>复制链接</Button>
            <Button className="button-secondary" onClick={() => setOneTimeLink(null)}>
              已保存，关闭
            </Button>
          </div>
        </Card>
      )}
      <Card>
        <div className="section-heading">
          <div>
            <h2>工作区成员</h2>
            <p>角色或停用状态变化会撤销该成员现有会话。</p>
          </div>
          <Badge tone="neutral">{members.data?.items.length ?? 0} 人</Badge>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>角色</th>
                <th>状态</th>
                <th>加入时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.data?.items.map((member) => (
                <tr key={member.id}>
                  <td>
                    <strong className="task-name">{member.displayName}</strong>
                    <small className="url-cell">{member.email}</small>
                  </td>
                  <td>
                    <select
                      aria-label={`${member.displayName} 的角色`}
                      disabled={mutation.isPending}
                      value={member.role}
                      onChange={(event) =>
                        updateMember(member, { role: event.target.value as IdentityRole })
                      }
                    >
                      {roleOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Badge tone={member.disabled ? 'danger' : 'success'}>
                      {member.disabled ? '已停用' : '正常'}
                    </Badge>
                  </td>
                  <td>{formatDate(member.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <Button
                        className="button-secondary"
                        disabled={mutation.isPending}
                        onClick={() => void createPasswordReset(member)}
                      >
                        重置密码
                      </Button>
                      <Button
                        className={member.disabled ? 'button-secondary' : 'button-danger'}
                        disabled={mutation.isPending || member.id === auth.user?.id}
                        onClick={() => updateMember(member, { disabled: !member.disabled })}
                      >
                        {member.disabled ? '重新启用' : '停用'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {members.isPending && <p role="status">正在加载成员…</p>}
      </Card>
      <Card>
        <div className="section-heading">
          <div>
            <h2>邀请新成员</h2>
            <p>邀请 72 小时内有效；P2 不发送邮件，请复制一次性链接并安全交给对方。</p>
          </div>
        </div>
        <form className="inline-invitation-form" onSubmit={(event) => void createInvitation(event)}>
          <label>
            <span>邮箱</span>
            <Input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>角色</span>
            <select value={role} onChange={(event) => setRole(event.target.value as IdentityRole)}>
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">生成邀请链接</Button>
        </form>
        <div className="invitation-list">
          {invitations.data?.items.map((invitation) => (
            <InvitationRow
              invitation={invitation}
              key={invitation.id}
              pending={mutation.isPending}
              regenerate={() =>
                void issueInvitation(invitation.email, invitation.role, invitation.id)
              }
              revoke={() => {
                setError('');
                mutation.mutate(() => runtimeClient.revokeInvitation(invitation.id));
              }}
            />
          ))}
          {!invitations.isPending && !invitations.data?.items.length && (
            <div className="empty-small">尚无邀请</div>
          )}
        </div>
      </Card>
    </>
  );
}

function InvitationRow(props: {
  invitation: IdentityInvitation;
  pending: boolean;
  revoke(): void;
  regenerate(): void;
}) {
  const status = invitationStatus(props.invitation);
  const statusLabel = {
    active: '等待接受',
    accepted: '已接受',
    revoked: '已撤销',
    expired: '已过期',
  }[status];
  return (
    <div className="invitation-row">
      <span>
        <strong>{props.invitation.email}</strong>
        <small>
          {roleLabel(props.invitation.role)} · 有效至 {formatDate(props.invitation.expiresAt)}
        </small>
      </span>
      <Badge tone={status === 'active' ? 'success' : 'neutral'}>{statusLabel}</Badge>
      {status === 'active' && (
        <div className="row-actions">
          <Button className="button-secondary" disabled={props.pending} onClick={props.regenerate}>
            重新生成
          </Button>
          <Button className="button-danger" disabled={props.pending} onClick={props.revoke}>
            撤销
          </Button>
        </div>
      )}
    </div>
  );
}

function roleLabel(role: IdentityRole): string {
  return roleOptions.find((option) => option.value === role)?.label ?? role;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function reportIdentityError(
  reason: unknown,
  auth: ReturnType<typeof useWorkspaceAuth>,
  setError: (message: string) => void,
): void {
  if (reason instanceof ApiError && reason.problem.code === 'CSRF_INVALID') {
    setError('当前会话需要重新验证，请登录后再执行写操作。');
    auth.requireLogin();
    return;
  }
  setError(errorMessage(reason));
}
