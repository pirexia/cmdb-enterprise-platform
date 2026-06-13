import type { Application } from 'express';
import { PrismaClient } from '@prisma/client';
import { pluginRuntime, RuntimePlugin } from './engine.js';
import { pluginAudit } from './audit.js';
import { getActivePlugins, setPluginStatus } from './queries.js';
import { createPluginRouter, createPluginPublicRouter, createPluginExtRouter } from './router.js';

export { emitHook } from './engine.js';
export { createPluginRouter };

/**
 * Called once from index.ts after all core middleware/routes are set up.
 * Mounts the plugin API (public UI + admin + dynamic ext routes) and
 * re-activates any plugins that were ACTIVE before a restart.
 */
export async function initializePluginEngine(
  app: Application,
  prisma: PrismaClient,
): Promise<void> {
  pluginRuntime.init(app, prisma);

  // 1. Public UI assets (GET /api/plugins/:id/ui[/*]) — NOT behind requireAdmin.
  //    Unmatched paths fall through to the admin router mounted next.
  app.use('/api/plugins', createPluginPublicRouter(prisma));

  // 2. Admin management API (requireAdmin on every route).
  app.use('/api/plugins', createPluginRouter(prisma));

  // 3. Dynamic plugin routes dispatcher (/api/ext/:pluginId/*).
  app.use('/api/ext', createPluginExtRouter(prisma));

  // Re-activate plugins that were ACTIVE before restart
  let active: Awaited<ReturnType<typeof getActivePlugins>>;
  try {
    active = await getActivePlugins(prisma);
  } catch {
    // DB may not have the plugin tables yet (first boot before migration)
    console.warn('[plugin-engine] plugin tables not found, skipping re-activation');
    return;
  }

  for (const plugin of active) {
    try {
      pluginRuntime.registerPlugin(plugin as unknown as RuntimePlugin);
      console.info(`[plugin-engine] re-activated plugin: ${plugin.pluginId} v${plugin.version}`);
    } catch (err) {
      console.error(`[plugin-engine] failed to re-activate plugin ${plugin.pluginId}:`, err);
      await setPluginStatus(prisma, plugin.id, 'ERROR', (err as Error).message).catch(() => {});
      await pluginAudit(prisma, 'PLUGIN_ERROR', plugin.id, 'system', {
        description: `Re-activation failed: ${(err as Error).message}`,
      }).catch(() => {});
    }
  }

  console.info(`[plugin-engine] initialized — ${active.length} plugin(s) re-activated`);
}
