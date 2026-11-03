import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../../.tmp/renderer-spike/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) });
await server.listen();
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROME ? 'chrome' : undefined });
const report: Record<string, unknown> = {
  measuredAt: new Date().toISOString(), version: { sigma: '4.0.4', graphology: '0.26.0' }, build: 'Vite development comparison spike',
  hardware: { os: platform(), cpu: cpus()[0].model, logicalCpus: cpus().length, ramBytes: totalmem() }, browser: browser.version(), viewport: { width: 1600, height: 1000 }, seed: 42,
  note: 'Isolated candidate proof, not a production migration or directly comparable to historical production Canvas timings. JS heap is target heap, not GPU or total process memory.', samples: [],
};
try {
  for (const files of [212, 2000]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    // tsx preserves nested callback names; its helper must also exist inside the
    // isolated page where Playwright serializes those measurement callbacks.
    await page.addInitScript('window.__name = target => target');
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:4366/?files=${files}`);
    await page.waitForFunction(() => (window as any).spike?.ready);
    await page.waitForFunction(() => (window as any).spike.renderCount > 0);
    const initial = await page.evaluate(() => {
      const data = (window as any).spike;
      const gl = data.renderer.getStageCanvas().getContext('webgl2');
      return { files: data.graph.order, edges: data.graph.size, islands: data.layout.islands.length, startupToObservationMs: performance.now() - data.startedAt, navigationToObservationMs: performance.now(), heapBytes: (performance as any).memory?.usedJSHeapSize ?? null, gpu: gl ? gl.getParameter(gl.RENDERER) : null };
    });
    if (initial.files !== files || initial.edges !== (files === 212 ? 235 : 8000)) throw new Error('Candidate lost domain objects');
    for (const [name, ratio] of [['overview', 1], ['out', 1.7], ['in', .5]] as const) {
      await page.evaluate(value => { (window as any).spike.renderer.getCamera().setState({ x: .5, y: .5, ratio: value }); }, ratio);
      await page.waitForTimeout(100);
      await page.screenshot({ path: `${output}/${files}-${name}.jpg`, quality: 82 });
    }
    await page.evaluate(() => (window as any).spike.renderer.getCamera().setState({ x: .5, y: .5, ratio: 1 }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const point = await page.evaluate(() => { const s = (window as any).spike, n = s.layout.nodes[0]; return { ...s.renderer.graphToViewport({ x: n.x, y: -n.y }), id: n.id, path: n.path }; });
    await page.mouse.click(point.x, point.y + 64);
    if (await page.locator('#status').textContent() !== point.path) throw new Error('Sigma picking did not select the positioned file');
    const focusedConnections = await page.evaluate(() => { const s = (window as any).spike; return s.graph.edges().filter((key: string) => s.graph.getEdgeAttribute(key, 'focused')).length; });
    if (focusedConnections < 1) throw new Error('Picked file did not expose connection focus');
    const frames = await page.evaluate(async () => {
      const samples: number[] = [], longTasks: number[] = []; const s = (window as any).spike;
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({ type: 'longtask', buffered: false });
      await new Promise<void>(resolve => {
        let count = 0, previous = performance.now();
        const frame = (now: number) => {
          if (count >= 5) samples.push(now - previous); previous = now;
          s.renderer.getCamera().setState({ x: count % 2 ? .49 : .51, y: .5, ratio: 1 });
          if (++count < 91) requestAnimationFrame(frame); else resolve();
        }; requestAnimationFrame(frame);
      });
      observer.disconnect(); samples.sort((a, b) => a - b);
      return { count: samples.length, frameMedianMs: samples[Math.floor(samples.length / 2)], frameP95Ms: samples[Math.floor(samples.length * .95)], longTasks, heapBytesAfterPan: (performance as any).memory?.usedJSHeapSize ?? null };
    });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    if (await page.locator('#file-list li').count() !== files) throw new Error('File fallback omitted files');
    if (errors.length) throw new Error(errors.join('\n'));
    (report.samples as unknown[]).push({ ...initial, ...frames, picking: 'passed', focusedConnections, fileList: 'complete', screenshots: ['overview', 'out', 'in'].map(name => `${files}-${name}.jpg`) });
    await page.close();
  }
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function(type: string, ...args: unknown[]) { return /^webgl/.test(type) ? null : original.call(this, type as any, ...args as []); };
  });
  await page.goto('http://127.0.0.1:4366/'); await page.locator('#fallback').waitFor({ state: 'visible' });
  if (await page.locator('#file-list li').count() !== 212) throw new Error('WebGL unavailable fallback incomplete');
  await page.getByRole('button', { name: 'Retry graph' }).click();
  report.webglFailure = { fallbackFiles: 212, retryButton: 'retains complete list when capability is still unavailable' };
  await page.close();
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await server.close(); }
