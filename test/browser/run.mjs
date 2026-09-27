import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { runScenarioFile, renderReport } from '../../dist/index.js';
import { loadNeveroversell } from '../../dist/cli/demo.js';
import { checkLaneReport, checkReport, checkStagedReport } from './report-checks.mjs';
import { checkLongEvidence, longEvidenceFixture } from './report-long-evidence.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Use npm run test:browser to provision a dedicated PostgreSQL server');
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
let server;
let browser;
try {
  const demo = await loadNeveroversell();
  const artifact = await runScenarioFile(fileURLToPath(new URL('../../dist/examples/neveroversell/demo-naive.js', import.meta.url)), {
    databaseUrl, signal: controller.signal, plan: [...demo.NAIVE_OVERSELL_PLAN],
    source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)), include: ['dist/examples/neveroversell/vendor/sql'] },
  });
  assert.equal(artifact.outcome, 'violation', artifact.reason);
  assert.equal(artifact.cleanup.complete, true);
  assert.ok(artifact.environment.fixture, 'Browser qualification must use an actual bound PostgreSQL run');
  assert.ok(artifact.environment.source, 'Browser qualification must bind actual application and runtime files');
  const html = await renderReport(artifact);
  const staged = await runScenarioFile(fileURLToPath(new URL('../../examples/postgresjs/scenario.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, protocolProfile: 'describe-flush-v1',
    source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(staged.outcome, 'violation', staged.reason);
  assert.equal(staged.cleanup.complete, true);
  assert.equal(staged.schemaVersion, 3);
  assert.equal(staged.limits.protocolProfile, 'describe-flush-v1');
  assert.ok(staged.environment.source);
  assert.ok(staged.trace.some(step => step.completion?.kind === 'metadata'));
  const stagedHtml = await renderReport(staged);
  const lanes = await runScenarioFile(fileURLToPath(new URL('../fixtures/cli/pool-lock.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, connectionProfile: 'multi-producer-v1', plan: ['alice#0', 'alice#0', 'alice#1', 'alice#0', 'bob'],
    source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(lanes.outcome, 'passed', lanes.reason);
  assert.equal(lanes.cleanup.complete, true);
  assert.equal(lanes.schemaVersion, 4);
  assert.ok(lanes.environment.source);
  const lanesHtml = await renderReport(lanes);
  const longEvidence = longEvidenceFixture();
  const longHtml = await renderReport(longEvidence);
  const pages = { '/staged': stagedHtml, '/long': longHtml, '/lanes': lanesHtml };
  server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pages[request.url] ?? html); });
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
        const stagedResult = await checkStagedReport(page, `${url}staged`, staged, artifact);
        const longResult = await checkLongEvidence(page, `${url}long`, longEvidence);
        const laneResult = await checkLaneReport(page, `${url}lanes`, lanes, artifact);
        console.log(`[browser] ${name} ${viewport.width}×${viewport.height}: ${result.checks.length} legacy + ${stagedResult.checks.length} staged + ${longResult.checks.length} synthetic long-evidence + ${laneResult.checks.length} connection-lane checks passed`);
      } finally { await page.close(); }
    }
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
