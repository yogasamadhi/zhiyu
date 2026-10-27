import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-api-remote-access/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import React from 'react';
import { Workbench } from '@zhiyun/dsh-workbench';
import type { RemoteApi } from './transport.js';
import styles from './styles.js';
import remoteContribution from '../../lib/typert.remote-client.js';

export const inject = ['slots', 'layout', 'remote', 'locale', 'remoteAccess'];
export async function apply(ctx: Context): Promise<void> {
  try {
    const unmount = await ctx.remote.$mount(remoteContribution).catch((error) => {
      console.error('ZhiYun Remote mount:', error);
      throw error;
    });
    ctx.effect(() => unmount, 'zhiyun: Remote namespace');
    await ctx.inject(['remote.zhiyun'], (ctx) => {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = 'dsh-zhiyun';
        style.textContent = styles;
        document.head.append(style);
        return () => style.remove();
      }, 'zhiyun: scoped styles');
      const raw = (
        ctx.remote as unknown as { zhiyun: Record<string, (...args: unknown[]) => unknown> }
      ).zhiyun;
      const unary = async (method: string, ...args: unknown[]) => {
        const result = (await raw[method]!(...args)) as {
          ok: boolean;
          value?: unknown;
          error?: { message: string };
        };
        if (!result.ok) throw new Error(result.error?.message ?? 'ZhiYun Host request failed');
        return result.value;
      };
      const remote = {
        credentialPrompts: (...args: unknown[]) => unary('credentialPrompts', ...args),
        answerCredentialPrompt: (...args: unknown[]) => unary('answerCredentialPrompt', ...args),
        workspaces: () => unary('workspaces'),
        status: (...args: unknown[]) => unary('status', ...args),
        invoke: (...args: unknown[]) => unary('invoke', ...args),
        events: (...args: unknown[]) => raw.events!(...args),
        readArtifact: (...args: unknown[]) => raw.readArtifact!(...args),
        saveArtifact: (...args: unknown[]) => unary('saveArtifact', ...args),
        setCredential: (...args: unknown[]) => unary('setCredential', ...args),
        selectExportDirectory: (...args: unknown[]) => unary('selectExportDirectory', ...args),
      } as unknown as RemoteApi;
      const Icon = ({ size = 18 }: { size?: number }) => (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d="M3 5h18v14H3zM3 10h18M9 5v14M15 5v14" />
        </svg>
      );
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: 'zhiyun' as never,
                inject: () => ({ remote, locale: ctx.locale }),
              },
              Workbench as never,
            ),
          ),
        'zhiyun: workbench',
      );
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: 'zhiyun',
                order: 20,
                label: () => (ctx.locale.getSnapshot().active === 'zh' ? '织云' : 'ZhiYun'),
              },
              Icon,
            ),
          ),
        'zhiyun: sidebar',
      );
    });
  } catch (error) {
    console.error('ZhiYun client activation:', error);
    throw error;
  }
}
