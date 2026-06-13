/**
 * PluginRuntime integration tests (H-01 / H-02).
 *
 * Exercises the live wiring end-to-end WITHOUT a DB or HTTP server:
 *  - registerPlugin → hookRegistry → emitHook runs handler code in the sandbox
 *  - registerPlugin → routeRegistry → runRoute dispatches to the sandbox handler
 *  - buildPrismaProxy enforces db:read / db:write capability gates
 *  - unregisterPlugin tears everything down
 */

import express from 'express';
import {
  pluginRuntime,
  routeRegistry,
  hookRegistry,
  emitHook,
  buildPrismaProxy,
  RuntimePlugin,
} from '../engine.js';

function fixture(overrides: Partial<RuntimePlugin>): RuntimePlugin {
  return {
    id: 'db-1',
    pluginId: 'hello-world',
    version: '1.0.0',
    permissions: ['hooks:register', 'routes:register'],
    manifest: {},
    config: {},
    hooks: [],
    cronJobs: [],
    routes: [],
    ...overrides,
  };
}

beforeAll(() => {
  pluginRuntime.init(express() as never, {} as never);
});

afterEach(() => {
  pluginRuntime.unregisterPlugin('db-1', 'hello-world');
});

describe('PluginRuntime — hooks', () => {
  it('runs a registered pre-hook in the sandbox and propagates a cancel', async () => {
    pluginRuntime.registerPlugin(fixture({
      hooks: [{
        event: 'preCreateCI',
        priority: 50,
        isActive: true,
        handlerCode: 'async function handler(d){ if(!d.body || !d.body.name) return { cancel: true, reason: "name required" }; }',
      }],
    }));

    expect(hookRegistry.hasHandlers('preCreateCI')).toBe(true);
    const res = await emitHook('preCreateCI', { body: {} }, 'pre');
    expect(res?.cancel).toBe(true);
    expect(res?.reason).toBe('name required');
  });

  it('does not cancel when the pre-hook returns nothing', async () => {
    pluginRuntime.registerPlugin(fixture({
      hooks: [{
        event: 'preCreateCI',
        priority: 50,
        isActive: true,
        handlerCode: 'async function handler(d){ return; }',
      }],
    }));
    const res = await emitHook('preCreateCI', { body: { name: 'x' } }, 'pre');
    expect(res).toBeNull();
  });

  it('unregisterPlugin removes the hook', async () => {
    pluginRuntime.registerPlugin(fixture({
      hooks: [{ event: 'preCreateCI', priority: 50, isActive: true, handlerCode: 'async function handler(){}' }],
    }));
    pluginRuntime.unregisterPlugin('db-1', 'hello-world');
    expect(hookRegistry.hasHandlers('preCreateCI')).toBe(false);
  });
});

describe('PluginRuntime — routes', () => {
  it('registers a route and dispatches it through the sandbox', async () => {
    pluginRuntime.registerPlugin(fixture({
      routes: [{
        method: 'GET',
        path: '/ping',
        isActive: true,
        requiresAuth: true,
        requiredRole: null,
        handlerCode: 'async function handler(req){ return { status: 200, body: { pong: true, role: req.user && req.user.role } }; }',
      }],
    }));

    const def = routeRegistry.match('hello-world', 'GET', '/ping');
    expect(def).toBeTruthy();

    const result = await pluginRuntime.runRoute(def!, { method: 'GET', path: '/ping', user: { role: 'AUDITOR' } }) as { status: number; body: { pong: boolean; role: string } };
    expect(result.status).toBe(200);
    expect(result.body.pong).toBe(true);
    expect(result.body.role).toBe('AUDITOR');
  });

  it('match is method- and path-exact', () => {
    pluginRuntime.registerPlugin(fixture({
      routes: [{ method: 'GET', path: '/ping', isActive: true, requiresAuth: false, requiredRole: null, handlerCode: 'async function handler(){ return {}; }' }],
    }));
    expect(routeRegistry.match('hello-world', 'POST', '/ping')).toBeNull();
    expect(routeRegistry.match('hello-world', 'GET', '/other')).toBeNull();
    expect(routeRegistry.match('other-plugin', 'GET', '/ping')).toBeNull();
  });
});

describe('buildPrismaProxy — capability gates', () => {
  it('blocks $executeRaw without db:write', () => {
    const proxy = buildPrismaProxy(['db:read']) as { $executeRaw: (...a: unknown[]) => unknown };
    expect(() => proxy.$executeRaw(['x'] as unknown)).toThrow('PLUGIN_PERM');
  });

  it('blocks $queryRaw without any db permission', () => {
    const proxy = buildPrismaProxy([]) as { $queryRaw: (...a: unknown[]) => unknown };
    expect(() => proxy.$queryRaw(['x'] as unknown)).toThrow('PLUGIN_PERM');
  });

  it('allows $queryRaw with db:read (then defers to PLUGIN_DATABASE_URL)', () => {
    const proxy = buildPrismaProxy(['db:read']) as { $queryRaw: (...a: unknown[]) => unknown };
    // Permission passes; without PLUGIN_DATABASE_URL the restricted client throws.
    const prev = process.env.PLUGIN_DATABASE_URL;
    delete process.env.PLUGIN_DATABASE_URL;
    expect(() => proxy.$queryRaw(['x'] as unknown)).toThrow('PLUGIN_DATABASE_URL');
    if (prev) process.env.PLUGIN_DATABASE_URL = prev;
  });
});
