import { HookRegistry, emitHook, hookRegistry } from '../engine.js';

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('emitHook returns null immediately when no handlers registered (early-return)', async () => {
    // emitHook uses the module-level hookRegistry singleton, which starts empty
    // Use a unique event name to ensure no interference
    const result = await emitHook('test:no-handlers:' + Date.now(), {}, 'pre');
    expect(result).toBeNull();
  });

  it('pre-hook cancel propagates — returns {cancel: true, reason}', async () => {
    const cancelHandler = jest.fn().mockResolvedValue({ cancel: true, reason: 'test cancel' });

    registry.register('ci:before-create', {
      pluginDbId: 'db-uuid-1',
      pluginId: 'test-plugin',
      priority: 10,
      handler: cancelHandler,
    });

    const result = await registry.emitPre('ci:before-create', { name: 'test' });
    expect(result).toEqual({ cancel: true, reason: 'test cancel' });
    expect(cancelHandler).toHaveBeenCalledWith({ name: 'test' });
  });

  it('post-hooks are fire-and-forget (Promise.allSettled — no throw on failure)', async () => {
    const failingHandler = jest.fn().mockRejectedValue(new Error('post-hook failure'));
    const successHandler = jest.fn().mockResolvedValue(undefined);

    registry.register('ci:after-create', {
      pluginDbId: 'db-uuid-2',
      pluginId: 'plugin-a',
      priority: 10,
      handler: failingHandler,
    });
    registry.register('ci:after-create', {
      pluginDbId: 'db-uuid-3',
      pluginId: 'plugin-b',
      priority: 20,
      handler: successHandler,
    });

    // emitPost should not throw even when a handler rejects
    await expect(registry.emitPost('ci:after-create', {})).resolves.toBeUndefined();
    expect(failingHandler).toHaveBeenCalled();
    expect(successHandler).toHaveBeenCalled();
  });

  it('registers and deregisters handlers by pluginId', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);

    registry.register('contract:after-update', {
      pluginDbId: 'db-uuid-4',
      pluginId: 'removable-plugin',
      priority: 5,
      handler,
    });

    expect(registry.hasHandlers('contract:after-update')).toBe(true);

    registry.unregisterPlugin('db-uuid-4');

    expect(registry.hasHandlers('contract:after-update')).toBe(false);
    // Handler should not be called after deregistration
    await registry.emitPost('contract:after-update', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('hasHandlers returns false for unknown event', () => {
    expect(registry.hasHandlers('event:that:does:not:exist')).toBe(false);
  });

  it('handlers are called in priority order (ascending)', async () => {
    const callOrder: number[] = [];

    registry.register('test:priority', {
      pluginDbId: 'db-uuid-5',
      pluginId: 'plugin-high',
      priority: 100,
      handler: jest.fn().mockImplementation(async () => { callOrder.push(100); }),
    });
    registry.register('test:priority', {
      pluginDbId: 'db-uuid-6',
      pluginId: 'plugin-low',
      priority: 1,
      handler: jest.fn().mockImplementation(async () => { callOrder.push(1); }),
    });
    registry.register('test:priority', {
      pluginDbId: 'db-uuid-7',
      pluginId: 'plugin-mid',
      priority: 50,
      handler: jest.fn().mockImplementation(async () => { callOrder.push(50); }),
    });

    await registry.emitPost('test:priority', {});
    expect(callOrder).toEqual([1, 50, 100]);
  });

  it('pre-hook stops at first cancel — subsequent handlers not called', async () => {
    const cancelHandler = jest.fn().mockResolvedValue({ cancel: true, reason: 'stop here' });
    const afterHandler = jest.fn().mockResolvedValue(undefined);

    registry.register('test:pre-cancel', {
      pluginDbId: 'db-uuid-8',
      pluginId: 'plugin-cancel',
      priority: 1,
      handler: cancelHandler,
    });
    registry.register('test:pre-cancel', {
      pluginDbId: 'db-uuid-9',
      pluginId: 'plugin-after',
      priority: 2,
      handler: afterHandler,
    });

    const result = await registry.emitPre('test:pre-cancel', {});
    expect(result).toEqual({ cancel: true, reason: 'stop here' });
    expect(afterHandler).not.toHaveBeenCalled();
  });
});
