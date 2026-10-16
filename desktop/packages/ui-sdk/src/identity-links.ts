export type WorkspaceTokenAction = 'invitation' | 'password-reset';

export function buildWorkspaceTokenLink(
  origin: string,
  action: WorkspaceTokenAction,
  token: string,
): string {
  const url = new URL('/', origin);
  url.hash = new URLSearchParams({ [action]: token }).toString();
  return url.toString();
}

export function workspaceTokenAction(
  fragment: string,
): { kind: WorkspaceTokenAction; token: string } | null {
  const parameters = new URLSearchParams(fragment.replace(/^#/u, ''));
  const invitation = parameters.get('invitation');
  if (invitation) return { kind: 'invitation', token: invitation };
  const passwordReset = parameters.get('password-reset');
  return passwordReset ? { kind: 'password-reset', token: passwordReset } : null;
}

export function withoutWorkspaceTokenAction(fragment: string): string {
  const parameters = new URLSearchParams(fragment.replace(/^#/u, ''));
  parameters.delete('invitation');
  parameters.delete('password-reset');
  const remainder = parameters.toString();
  return remainder ? `#${remainder}` : '';
}

export function consumeWorkspaceTokenAction(
  href: string,
  replaceLocation: (location: string) => void,
): { kind: WorkspaceTokenAction; token: string } | null {
  const url = new URL(href);
  const action = workspaceTokenAction(url.hash);
  if (!action) return null;
  replaceLocation(`${url.pathname}${url.search}${withoutWorkspaceTokenAction(url.hash)}`);
  return action;
}

export function invitationStatus(invitation: {
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
}): 'active' | 'accepted' | 'revoked' | 'expired' {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.revokedAt) return 'revoked';
  return Date.parse(invitation.expiresAt) <= Date.now() ? 'expired' : 'active';
}
