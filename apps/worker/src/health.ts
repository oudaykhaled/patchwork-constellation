import { Worker } from 'node:worker_threads';

/** Exercises the actual analysis entry point without fetching repository/model data. */
export function checkWorkerHealth(): Promise<{ status: 'ok'; schemaVersion: '1' }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./thread.ts', import.meta.url), {
      workerData: { task: { kind: 'health' }, options: {} },
      execArgv: ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().then(() => error ? reject(error) : resolve({ status: 'ok', schemaVersion: '1' }), reject);
    };
    const timeout = setTimeout(() => finish(new Error('Worker health probe timed out.')), 10_000);
    worker.once('message', message => {
      if (message?.type === 'health' && message.schemaVersion === '1') finish();
      else finish(new Error('Worker health probe returned an invalid response.'));
    });
    worker.once('error', () => finish(new Error('Analysis worker could not start.')));
    worker.once('exit', () => { if (!settled) finish(new Error('Analysis worker exited before its health response.')); });
  });
}
