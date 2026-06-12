import type { Application } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  hookRegistry,
  cronRegistry,
  routeRegistry,
  lifecycleManager,
  createSandboxExecutor,
  createMigrationRunner,
} from './engine.js';
import { pluginAudit } from './audit.js';
import { getActivePlugins, setPluginStatus } from './queries.js';
import { createPluginRouter } from './router.js';

export { emitHook } from './engine.js';
export { createPluginRouter };

const PLUGIN_STORAGE_PATH = process.env.PLUGIN_STORAGE_PATH ?? '/var/lib/cmdb/plugins';

/**
 * Called once from index.ts after all middleware/routes are set up.
 * Re-activates any plugins that were ACTIVE before a restart.
 */
export async function initializePluginEngine(
  app: Application,
  prisma: PrismaClient,
): Promise<void> {
  // Mount the plugin management API
  app.use('/api/plugins', createPluginRouter(prisma));

  // Re-activate plugins that were ACTIVE before restart
  let active: Awaited<ReturnType<typeof getActivePlugins>>;
  try {
    active = await getActivePlugins(prisma);
  } catch {
    // DB may not have the plugin tables yet (first boot before migration)
    console.warn('[plugin-engine] plugin tables not found, skipping re-activation');
    return;
  }

  const sandbox = createSandboxExecutor(PLUGIN_STORAGE_PATH);
  const migRunner = createMigrationRunner(PLUGIN_STORAGE_PATH);

  for (const plugin of active) {
    try {
      // Re-register hooks
      for (const hook of plugin.hooks.filter((h: { isActive: boolean }) => h.isActive)) {
        hookRegistry.register(hook.event, {
          pluginDbId: plugin.id,
          pluginId: plugin.pluginId,
          priority: hook.priority,
          handler: async (data) => {
            const manifest = plugin.manifest as { allowedHosts?: string[] };
            return sandbox.runHandler(
              hook.handlerCode,
              'handler',
              data,
              {} /* prismaProxy — wired in T3 */,
              console,
              plugin.config as Record<string, unknown>,
              manifest.allowedHosts ?? [],
            );
          },
        });
      }

      // Re-register cron jobs (node-cron)
      for (const job of plugin.cronJobs.filter((j: { isActive: boolean }) => j.isActive)) {
        try {
          const cron = await import('node-cron');
          const task = cron.schedule(job.schedule, async () => {
            try {
              const manifest = plugin.manifest as { allowedHosts?: string[] };
              await sandbox.runHandler(
                job.handlerCode,
                'handler',
                {},
                {},
                console,
                plugin.config as Record<string, unknown>,
                manifest.allowedHosts ?? [],
              );
              await prisma.pluginCronJob.update({
                where: { id: job.id },
                data: { lastRunAt: new Date() },
              });
            } catch (err) {
              console.error(`[plugin:${plugin.pluginId}] cron ${job.name} error:`, err);
            }
          });
          cronRegistry.register(plugin.id, { pluginDbId: plugin.id, stop: () => task.stop() });
        } catch (cronErr) {
          console.error(`[plugin:${plugin.pluginId}] failed to re-register cron ${job.name}:`, cronErr);
        }
      }

      routeRegistry.mount(app, plugin.id, plugin.pluginId);
      console.info(`[plugin-engine] re-activated plugin: ${plugin.pluginId} v${plugin.version}`);
    } catch (err) {
      console.error(`[plugin-engine] failed to re-activate plugin ${plugin.pluginId}:`, err);
      await setPluginStatus(prisma, plugin.id, 'ERROR', (err as Error).message).catch(() => {});
      await pluginAudit(prisma, 'PLUGIN_ERROR', plugin.pluginId, 'system', {
        description: `Re-activation failed: ${(err as Error).message}`,
      }).catch(() => {});
    }
  }

  console.info(`[plugin-engine] initialized — ${active.length} plugin(s) re-activated`);
}
