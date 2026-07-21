import type { Application, RequestHandler } from 'express';
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
  authenticateToken: RequestHandler,
): Promise<void> {
  pluginRuntime.init(app, prisma);

  // 1. Public UI assets (GET /api/plugins/:id/ui[/*]) — NOT behind requireAdmin.
  //    authenticateToken required so req.user is available to the renderer.
  app.use('/api/plugins', authenticateToken, createPluginPublicRouter(prisma));

  // 2. Admin management API — authenticateToken sets req.user; internal
  //    requireAdmin checks role. Without authenticateToken req.user is undefined
  //    and requireAdmin always returns 403, even for genuine ADMIN sessions.
  app.use('/api/plugins', authenticateToken, createPluginRouter(prisma));

  // 3. Dynamic plugin routes dispatcher (/api/ext/:pluginId/*).
  app.use('/api/ext', authenticateToken, createPluginExtRouter(prisma));

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
      // Issue #172 (ISO 27001 A.8.15): the ERROR status write and its audit
      // record must be atomic — wrapped in a transaction so a failed audit
      // insert never leaves an unlogged status mutation. Best-effort at
      // startup (non-critical path), so failures are still swallowed.
      await prisma.$transaction(async (tx) => {
        await setPluginStatus(tx, plugin.id, 'ERROR', (err as Error).message);
        await pluginAudit(tx, 'PLUGIN_ERROR', plugin.id, 'system', {
          description: `Re-activation failed: ${(err as Error).message}`,
        });
      }).catch(() => {});
    }
  }

  console.info(`[plugin-engine] initialized — ${active.length} plugin(s) re-activated`);
}
