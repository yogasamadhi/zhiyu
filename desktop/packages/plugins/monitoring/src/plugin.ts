import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import {
  MonitoringEvaluationOutbox,
  MonitoringService,
  createMonitoringEvaluationJobHandler,
  enqueueMonitoringEvaluation,
  registerMonitoringHttp,
} from './index.js';
import { deliverLocalMonitoringNotification } from './local-notifications.js';

export const inject = [
  'enqueueOutputEventNotifications',
  'hostCapabilities',
  'jobHandlers',
  'jobs',
  'runtimeHost',
];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const monitoring = new MonitoringService(repositories.monitoring, {
    async issue(evaluation, notification) {
      await ctx.enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: ctx.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.issue.detected',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: notification.severity,
          payload: notification.payload,
        },
      );
      await deliverLocalMonitoringNotification(ctx.hostCapabilities, repositories.platform, {
        eventId: notification.eventId,
        taskId: evaluation.taskId,
        runId: evaluation.runId,
        type: 'issue',
        issueCount:
          typeof notification.payload.issueCount === 'number' ? notification.payload.issueCount : 1,
      });
    },
    async recovered(evaluation, notification) {
      await ctx.enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: ctx.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.recovered',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: 'info',
          payload: notification.payload,
        },
      );
      await deliverLocalMonitoringNotification(ctx.hostCapabilities, repositories.platform, {
        eventId: notification.eventId,
        taskId: evaluation.taskId,
        runId: evaluation.runId,
        type: 'recovered',
      });
    },
  });
  return { monitoring, enqueueMonitoringEvaluation };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    monitoring: Services['monitoring'];
    enqueueMonitoringEvaluation: Services['enqueueMonitoringEvaluation'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.monitoring;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'monitoring-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('monitoring.service', services.monitoring);
  const { monitoring } = services;
  ctx.provide('monitoring', services.monitoring);
  ctx.provide('enqueueMonitoringEvaluation', services.enqueueMonitoringEvaluation);
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
        type: 'monitoring.quality.evaluate',
        ownerPluginId: 'monitoring',
        resourceClass: 'io',
        handler: createMonitoringEvaluationJobHandler({
          service: monitoring,
          collection: repositories.collection,
          datasets: repositories.datasets,
        }),
      }),
    'job-handler',
  );
  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('monitoring', async (app) => {
        await registerMonitoringHttp(app, {
          repository: repositories.monitoring,
          tasks: repositories.collection,
        });
      }),
    'monitoring-http',
  );
  ownRuntimeEffect(
    ctx,
    new MonitoringEvaluationOutbox(repositories.platform, ctx.jobs),
    'monitoring-outbox',
  );
}
export default { inject, Config, apply };
