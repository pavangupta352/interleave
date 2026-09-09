import assert from 'node:assert/strict';

/** Inert viewer fixture, deliberately independent of database reproduction evidence. */
export function longEvidenceFixture() {
  const actors = Array.from({ length: 8 }, (_, index) => `actor${index}_${'x'.repeat(41)}`);
  const evidence = label => Array.from({ length: 140 }, (_, index) => `${label} line ${index + 1}: recorded observation for inspection`).join('\n') + `\n${label}_FINAL_MARKER`;
  return {
    schemaVersion: 1, scenario: 'Browser qualification: eight actors and long evidence', outcome: 'violation', mode: 'explore', plan: [],
    trace: Array.from({ length: 1001 }, (_, index) => ({
      index, actor: actors[index % 8], connection: 0, ordinal: Math.floor(index / 8), protocol: 'simple',
      sql: `SELECT ${index}; -- ${'recorded SQL context '.repeat(index === 401 ? 1400 : 40)}`,
      fingerprint: 'a'.repeat(64), backendPid: 101 + index % 8, available: actors,
      releasedAt: index * 2, completedAt: index * 2 + 1,
      completion: index === 401
        ? { transactionStatus: 'E', commandTags: [], rowCount: 0, error: { code: '40P01', message: evidence('ERROR') } }
        : { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 },
      waits: index === 401 ? [{ pid: 102, blockerPids: [101, 108], waitEventType: 'Lock', waitEvent: 'transactionid' }] : [],
    })),
    actors: actors.map((actor, index) => ({ actor, status: 'fulfilled', value: { evidence: evidence(`ACTOR_${index}`) } })),
    failure: { name: 'AssertionError', message: evidence('SUMMARY'), fingerprint: 'b'.repeat(64) },
    environment: { serverVersion: '16.15', nodeVersion: process.version }, startedAt: '2026-09-09T00:00:00.000Z', durationMs: 2002,
    limits: { maxSteps: 5000, timeoutMs: 10000 }, cleanup: { complete: true },
  };
}

/** Exercise full evidence access, beyond merely checking focus attributes. */
export async function checkLongEvidence(page, url, artifact) {
  const errors = [], requests = [], viewport = page.viewportSize();
  const onError = error => errors.push(error.message);
  const onRequest = request => { if (request.url() !== url) requests.push(request.url()); };
  page.on('pageerror', onError); page.on('request', onRequest);
  try {
    await page.goto(url); await page.getByRole('heading', { name: artifact.scenario, exact: true }).waitFor();
    const fits = [];
    for (const width of new Set([viewport.width, 320])) {
      await page.setViewportSize({ width, height: viewport.height });
      fits.push({ width, fits: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) });
    }
    await page.setViewportSize(viewport);
    await page.getByRole('searchbox').fill('SELECT 401;');
    await page.waitForFunction(() => document.querySelectorAll('.command').length === 1 && document.querySelector('.command').dataset.step === '401');
    await page.locator('.command').click();
    assert.equal(await page.locator('.sql-full').textContent(), artifact.trace[401].sql);
    assert.ok((await page.locator('.wait-observation').textContent()).includes(artifact.actors[0].actor));
    assert.ok((await page.locator('.wait-observation').textContent()).includes(artifact.actors[7].actor));
    await page.locator('.observations summary').click();
    assert.equal(await page.locator('.actor-result').count(), 8);
    await page.setViewportSize({ width: 320, height: viewport.height });
    const actorReferencesFit = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('#selection-label, .mobile-actor, .wait-observation, .actor-result h3, #status')]
        .every(element => element.scrollWidth <= element.clientWidth + 1));
    await page.setViewportSize(viewport);
    const targets = ['.summary-message', '.sql-full', '.error-message', ...Array.from({ length: 8 }, (_, index) => `.actor-result:nth-of-type(${index + 1}) pre`)];
    const reached = new Set();
    await page.getByRole('button', { name: 'Open artifact', exact: true }).focus();
    for (let turn = 0; turn < 45 && reached.size < targets.length; turn++) {
      await page.keyboard.press('Tab');
      const current = await page.evaluate(selectors => selectors.find(selector => document.querySelector(selector) === document.activeElement), targets);
      if (!current || reached.has(current)) continue;
      await page.keyboard.press('End');
      await page.waitForFunction(selector => { const element = document.querySelector(selector); return element.scrollTop >= element.scrollHeight - element.clientHeight - 2; }, current);
      reached.add(current);
    }
    const beforeExit = await page.evaluate(() => document.activeElement?.className);
    await page.keyboard.press('Tab');
    const leftEvidence = await page.evaluate(() => !document.activeElement?.matches('.actor-result pre'));
    const namedEvidence = {
      outcome: await page.getByRole('region', { name: 'Execution outcome message', exact: true }).count(),
      error: await page.getByRole('region', { name: 'PostgreSQL error message', exact: true }).count(),
      observations: await page.getByRole('region', { name: / observation$/ }).count(),
    };
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.locator('.command').focus();
    const displayModes = await page.locator('.command').evaluate(element => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, focusVisible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
        selected: element.getAttribute('aria-pressed'), writtenSelection: document.querySelector('#selection-label').textContent.includes('step 402') };
    });
    assert.deepEqual({ fits, actorReferencesFit, unreachable: targets.filter(selector => !reached.has(selector)), leftEvidence, namedEvidence, displayModes }, {
      fits: [...new Set([viewport.width, 320])].map(width => ({ width, fits: true })), unreachable: [], leftEvidence: true,
      actorReferencesFit: true,
      namedEvidence: { outcome: 1, error: 1, observations: 8 },
      displayModes: { animation: 'none', focusVisible: true, selected: 'true', writtenSelection: true },
    }, `Long evidence remains reachable without losing actor identity; final keyboard position was ${beforeExit}`);
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    return { checks: ['eight-actor and 320px reflow', 'exact long SQL and blocker identities', 'keyboard access to evidence tails and exit', 'named evidence regions', 'forced-colors focus and written selection', 'reduced-motion feedback', 'no errors or external requests'], passed: true };
  } finally { await page.setViewportSize(viewport); await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' }); page.off('pageerror', onError); page.off('request', onRequest); }
}
