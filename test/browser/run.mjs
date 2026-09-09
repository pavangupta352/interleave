import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { runOnce, renderReport } from '../../dist/index.js';
import { loadNeveroversell } from '../../dist/cli/demo.js';
import { checkReport } from './report-checks.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Use npm run test:browser to provision a dedicated PostgreSQL server');
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
let server;
let browser;
try {
  const demo = await loadNeveroversell();
  const artifact = await runOnce(demo.createNaiveOversellScenario(), { databaseUrl, signal: controller.signal, plan: [...demo.NAIVE_OVERSELL_PLAN] });
  assert.equal(artifact.outcome, 'violation', artifact.reason);
  assert.equal(artifact.cleanup.complete, true);
  assert.ok(artifact.environment.fixture, 'Browser qualification must use an actual bound PostgreSQL run');
  const html = await renderReport(artifact);
  server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    controller.signal.throwIfAborted();
    browser = await engine.launch();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      controller.signal.throwIfAborted();
      const page = await browser.newPage({ viewport, acceptDownloads: true });
      try {
        const result = await checkReport(page, url, artifact);
        console.log(`[browser] ${name} ${viewport.width}×${viewport.height}: ${result.checks.length} checks passed`);
      } finally { await page.close(); }
    }
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
