import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { runScenarioFile, renderReport } from '../../dist/index.js';
import { loadNeveroversell } from '../../dist/cli/demo.js';
import { checkCancelReport, checkCopyReport, checkFlushReport, checkLaneReport, checkOverlapReport, checkReport, checkStagedReport } from './report-checks.mjs';
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
  const pair = await runScenarioFile(fileURLToPath(new URL('../fixtures/cli/claim.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, overlap: 'pairs', plan: ['alice+bob'],
    source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(pair.outcome, 'violation', pair.reason);
  assert.equal(pair.cleanup.complete, true);
  assert.equal(pair.schemaVersion, 4);
  assert.equal(pair.limits.overlap, 'pairs');
  const pairHtml = await renderReport(pair);
  const cancel = await runScenarioFile(fileURLToPath(new URL('../fixtures/cli/cancel.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(cancel.outcome, 'passed', cancel.reason);
  assert.equal(cancel.cleanup.complete, true);
  assert.equal(cancel.schemaVersion, 5);
  const cancelHtml = await renderReport(cancel);
  const copy = await runScenarioFile(fileURLToPath(new URL('../fixtures/cli/copy.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(copy.outcome, 'passed', copy.reason);
  assert.equal(copy.cleanup.complete, true);
  assert.equal(copy.schemaVersion, 5);
  const copyHtml = await renderReport(copy);
  const cursor = await runScenarioFile(fileURLToPath(new URL('../fixtures/cli/cursor.mjs', import.meta.url)), {
    databaseUrl, signal: controller.signal, protocolProfile: 'flush-stages-v1', plan: ['alice', 'alice', 'bob'],
    source: { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  });
  assert.equal(cursor.outcome, 'passed', cursor.reason);
  assert.equal(cursor.cleanup.complete, true);
  assert.equal(cursor.limits.protocolProfile, 'flush-stages-v1');
  const cursorHtml = await renderReport(cursor);
  const longEvidence = longEvidenceFixture();
  const longHtml = await renderReport(longEvidence);
  const pages = { '/staged': stagedHtml, '/long': longHtml, '/lanes': lanesHtml, '/pair': pairHtml, '/cancel': cancelHtml, '/copy': copyHtml, '/cursor': cursorHtml };
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
        const pairResult = await checkOverlapReport(page, `${url}pair`, pair, artifact);
        const cancelResult = await checkCancelReport(page, `${url}cancel`, cancel, artifact);
        const copyResult = await checkCopyReport(page, `${url}copy`, copy);
        const flushResult = await checkFlushReport(page, `${url}cursor`, cursor);
        console.log(`[browser] ${name} ${viewport.width}×${viewport.height}: ${result.checks.length} legacy + ${stagedResult.checks.length} staged + ${longResult.checks.length} synthetic long-evidence + ${laneResult.checks.length} connection-lane + ${pairResult.checks.length} overlapped-pair + ${cancelResult.checks.length} cancel-request + ${copyResult.checks.length} COPY + ${flushResult.checks.length} Flush-stage checks passed`);
      } finally { await page.close(); }
    }
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
