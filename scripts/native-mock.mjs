import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createMockPanel } from '../server/mock-xtream.mjs';

// Synchronous device commands must not prevent the fixture provider from
// serving network data. The provider has its own event loop.
if (!isMainThread) {
  const panel = createMockPanel(workerData.options);
  await new Promise((resolve, reject) => {
    panel.server.once('error', reject);
    panel.server.listen(workerData.port ?? 0, '127.0.0.1', resolve);
  });
  parentPort.postMessage({ ready: true, port: panel.server.address().port });
  parentPort.on('message', async ({ id, command }) => {
    if (command === 'stats') parentPort.postMessage({ id, value: panel.stats });
    if (command === 'close') {
      panel.server.closeAllConnections();
      await new Promise((resolve) => panel.server.close(resolve));
      parentPort.postMessage({ id, value: true });
      parentPort.close();
    }
  });
}

export function startNativeMock(options, port) {
  const worker = new Worker(new URL('./native-mock.mjs', import.meta.url), {
    workerData: { options, port },
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
  });
  let id = 0;
  const pending = new Map();
  let closed = false;
  let exited = false;
  const request = (command) => new Promise((resolve, reject) => {
    if (exited) { reject(new Error('Native fixture worker has exited.')); return; }
    const key = ++id;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error('Native fixture worker did not respond within ten seconds.'));
    }, 10000);
    pending.set(key, { resolve, reject, timer });
    worker.postMessage({ id: key, command });
  });
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      reject(error);
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(error);
      }
      pending.clear();
    };
    const readyTimer = setTimeout(() => {
      fail(new Error('Native fixture worker did not start within ten seconds.'));
      void worker.terminate();
    }, 10000);
    worker.on('error', (error) => {
      clearTimeout(readyTimer);
      fail(error);
    });
    worker.on('exit', () => {
      exited = true;
      clearTimeout(readyTimer);
      fail(new Error('Native fixture worker exited before completing the operation.'));
    });
    worker.on('message', (message) => {
      if (message.ready) {
        clearTimeout(readyTimer);
        resolve({
          port: message.port,
          stats: () => request('stats'),
          close: async () => {
            if (closed) return;
            closed = true;
            try { await request('close'); } finally { await worker.terminate(); }
          },
        });
      } else {
        const operation = pending.get(message.id);
        if (operation) {
          clearTimeout(operation.timer);
          operation.resolve(message.value);
        }
        pending.delete(message.id);
      }
    });
  });
}
