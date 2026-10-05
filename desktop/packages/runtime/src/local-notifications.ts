import type { HostCapabilities, LocalNotificationResult } from '@zhiyun/contracts';
import type { PlatformRepository } from '@zhiyun/platform-core';

export async function deliverLocalMonitoringNotification(
  host: Pick<HostCapabilities, 'notify'>,
  platform: PlatformRepository,
  input: {
    eventId: string;
    taskId: string;
    runId: string;
    type: 'issue' | 'recovered';
    issueCount?: number;
  },
): Promise<void> {
  let status: LocalNotificationResult['status'] = 'unsupported';
  if (host.notify) {
    try {
      const result = await host.notify(
        input.type === 'issue' ? '织云任务需要关注' : '织云任务已恢复',
        input.type === 'issue'
          ? `检测到 ${input.issueCount ?? 1} 项异常。请在应用内查看。任务 ${input.taskId}，运行 ${input.runId}`
          : `任务 ${input.taskId}，运行 ${input.runId} 已恢复健康。`,
      );
      status = result?.status ?? 'unconfirmed';
    } catch {
      status = 'failed';
    }
  }
  // Persist the outcome without OS errors, field names, record values or credentials.
  await platform.appendEvent({
    type: 'monitoring.notification.local',
    producerPluginId: 'monitoring',
    aggregateType: 'task-health',
    aggregateId: input.taskId,
    payload: {
      taskId: input.taskId,
      runId: input.runId,
      notificationEventId: input.eventId,
      status,
    },
  });
}
