/**
 * SandboxExecutor tests
 *
 * The frozen-context bug (ctx was frozen before `__pluginData__` was injected) was
 * fixed by passing `data` into buildFrozenContext before the freeze. These tests now
 * verify the real sandbox isolation guarantees of the vm.Script executor.
 *
 * NOTE: per the D1 trust model, vm.Script is defense-in-depth, NOT the security
 * boundary. These tests assert the hardening (frozen context, blocked globals,
 * timeout) holds, but the primary control is the admission gate.
 */

import { SandboxExecutor } from '../engine.js';

const STORAGE_PATH = '/tmp/plugin-sandbox-test';

function makeExecutor(): SandboxExecutor {
  return new SandboxExecutor(STORAGE_PATH);
}

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('SandboxExecutor', () => {
  it('executes simple valid handler code and returns result', async () => {
    const executor = makeExecutor();
    const code = `async function handle(data) { return { processed: true, input: data }; }`;
    const result = await executor.runHandler(
      code, 'handle', { key: 'value' }, {}, makeLogger(), {}, [],
    );
    expect(result).toEqual({ processed: true, input: { key: 'value' } });
  });

  it('aborts handler that exceeds the 5s timeout', async () => {
    const executor = makeExecutor();
    const code = `async function infiniteLoop(data) { while(true) {} }`;
    await expect(
      executor.runHandler(code, 'infiniteLoop', {}, {}, makeLogger(), {}, []),
    ).rejects.toThrow(/PLUGIN_TIMEOUT|timed out/i);
  }, 10000);

  it('blocks access to process', async () => {
    const executor = makeExecutor();
    const code = `async function tryProcess(data) { return typeof process; }`;
    const result = await executor.runHandler(code, 'tryProcess', {}, {}, makeLogger(), {}, []);
    expect(result).toBe('undefined');
  });

  it('blocks access to require', async () => {
    const executor = makeExecutor();
    const code = `async function tryRequire(data) { return typeof require; }`;
    const result = await executor.runHandler(code, 'tryRequire', {}, {}, makeLogger(), {}, []);
    expect(result).toBe('undefined');
  });

  it('blocks require("fs")', async () => {
    const executor = makeExecutor();
    const code = `
      async function tryFs(data) {
        try { const fs = require('fs'); return 'got-fs'; }
        catch (e) { return 'blocked: ' + e.message; }
      }
    `;
    const result = await executor.runHandler(code, 'tryFs', {}, {}, makeLogger(), {}, []) as string;
    expect(String(result)).toContain('blocked');
  });

  it('blocks eval()', async () => {
    const executor = makeExecutor();
    const code = `
      async function tryEval(data) {
        try { return eval('1+1'); }
        catch(e) { return 'blocked'; }
      }
    `;
    const result = await executor.runHandler(code, 'tryEval', {}, {}, makeLogger(), {}, []);
    expect(result).toBe('blocked');
  });

  it('blocks the Function constructor', async () => {
    const executor = makeExecutor();
    const code = `
      async function tryFunction(data) {
        try { return Function('return 1')(); }
        catch(e) { return 'blocked'; }
      }
    `;
    const result = await executor.runHandler(code, 'tryFunction', {}, {}, makeLogger(), {}, []);
    expect(result).toBe('blocked');
  });

  it('allows access to provided context (logger, config)', async () => {
    const executor = makeExecutor();
    const logger = makeLogger();
    const config = { myKey: 'myValue' };
    const code = `
      async function useContext(data) {
        logger.info('hello from plugin');
        return config.myKey;
      }
    `;
    const result = await executor.runHandler(code, 'useContext', {}, {}, logger, config, []);
    expect(result).toBe('myValue');
    expect(logger.info).toHaveBeenCalledWith('hello from plugin');
  });

  it('pre-hook can cancel by returning {cancel: true, reason}', async () => {
    const executor = makeExecutor();
    const code = `
      async function preHook(data) {
        if (data && data.blocked) { return { cancel: true, reason: 'blocked by policy' }; }
        return { cancel: false };
      }
    `;
    const result = await executor.runHandler(
      code, 'preHook', { blocked: true }, {}, makeLogger(), {}, [],
    ) as { cancel: boolean; reason: string };
    expect(result.cancel).toBe(true);
    expect(result.reason).toBe('blocked by policy');
  });
});
