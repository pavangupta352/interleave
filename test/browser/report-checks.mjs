import assert from 'node:assert/strict';

/** Browser qualification shared by local review and the browser CI job. */
export async function checkReport(page, url, artifact) {
  const errors = [];
  const unexpectedRequests = [];
  const onError = error => errors.push(error.message);
  const onRequest = request => { if (request.url() !== url) unexpectedRequests.push(request.url()); };
  page.on('pageerror', onError); page.on('request', onRequest);
  try {
    await page.goto(url);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('heading', { name: artifact.scenario, exact: true }).waitFor();
    await page.locator('.record-details summary').click();
    if (artifact.environment.fixture) {
      assert.equal(await page.locator('.record-body').getByText(artifact.environment.fixture.fingerprint, { exact: true }).count(), 1);
    }
    for (const connection of artifact.connections ?? []) {
      assert.ok(await page.locator('.record-body').getByText(connection.fingerprint, { exact: true }).count() > 0);
    }
    if (artifact.environment.source) {
      assert.equal(await page.locator('.record-body').getByText(artifact.environment.source.fingerprint, { exact: true }).count(), 1);
      assert.equal(await page.locator('.record-body').getByText(artifact.environment.source.entry, { exact: true }).count(), 1);
      assert.ok((await page.locator('.record-body').textContent()).includes(artifact.environment.source.components.runtime.fingerprint));
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded record identities fit the viewport');
    await page.locator('.record-details summary').click();
    const input = page.locator('#import-file');
    const upload = async (name, value) => input.evaluate((element, data) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([data.text], data.name, { type: 'application/json' }));
      element.files = transfer.files; element.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name, text: typeof value === 'string' ? value : JSON.stringify(value) });
    const originalName = artifact.scenario;
    await upload('invalid.json', { ...artifact, schemaVersion: 99 });
    await page.getByRole('status').filter({ hasText: /Could not open invalid.json/ }).waitFor();
    assert.equal(await page.locator('#scenario').textContent(), originalName);
    await input.evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([255, 254])], 'bad-utf8.json')); element.files = transfer.files; element.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.getByRole('status').filter({ hasText: /Could not open bad-utf8.json/ }).waitFor();
    assert.equal(await page.locator('#scenario').textContent(), originalName);
    await input.evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'oversized.json')); element.files = transfer.files; element.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.getByRole('status').filter({ hasText: /16 MiB limit/ }).waitFor();
    assert.equal(await page.locator('#scenario').textContent(), originalName);

    const hostile = structuredClone(artifact);
    hostile.scenario = '<img src=x onerror=globalThis.reportAttack=1>';
    hostile.trace[0].sql = '</script><script>globalThis.reportAttack=1</script><img src="https://example.invalid/leak" onerror="globalThis.reportAttack=1">';
    hostile.actors[0].value = { private: '<svg onload="globalThis.reportAttack=1">' };
    await upload('hostile.json', hostile);
    await page.getByRole('heading', { name: hostile.scenario, exact: true }).waitFor();
    await page.locator('.command[data-step="0"]').click();
    assert.equal(await page.locator('.sql-full').textContent(), hostile.trace[0].sql);
    assert.equal(await page.locator('img, svg').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.reportAttack), undefined);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), hostile);

    const long = structuredClone(artifact);
    long.scenario = 'Browser qualification: 201 commands';
    long.outcome = 'passed'; delete long.failure; delete long.reason;
    long.plan = []; long.durationMs = 402; long.limits.maxSteps = 1000;
    long.trace = Array.from({ length: 201 }, (_, index) => ({
      ...artifact.trace[0], index, actor: index % 2 ? 'bob' : 'alice', connection: 0, ordinal: Math.floor(index / 2),
      sql: `SELECT ${index}`, backendPid: index % 2 ? 102 : 101, releasedAt: index * 2, completedAt: index * 2 + 1,
      completion: { transactionStatus: 'I', commandTags: ['SELECT 1'], rowCount: 1 }, waits: [], available: ['alice', 'bob'],
    }));
    long.actors = [{ actor: 'alice', status: 'fulfilled' }, { actor: 'bob', status: 'fulfilled' }];
    await upload('long.json', long);
    await page.getByRole('heading', { name: long.scenario, exact: true }).waitFor();
    assert.equal(await page.locator('.command').count(), 100);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const nextRect = await page.locator('.command[data-step="100"]').boundingBox();
    assert.ok(nextRect.y >= 0 && nextRect.y < page.viewportSize().height - nextRect.height, 'Next reveals the first command on the new page');
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    const previousRect = await page.locator('.command[data-step="0"]').boundingBox();
    assert.ok(previousRect.y >= 0 && previousRect.y < page.viewportSize().height - previousRect.height, 'Previous reveals the first command on the new page');
    await page.locator('.command[data-step="99"]').focus();
    await page.locator('.command[data-step="99"]').press('ArrowDown');
    assert.equal(await page.locator('.command[aria-pressed="true"]').getAttribute('data-step'), '100');
    assert.equal(await page.locator('.command').count(), 100);
    await page.locator('.command[data-step="100"]').press('End');
    assert.equal(await page.locator('.command[aria-pressed="true"]').getAttribute('data-step'), '200');
    assert.equal(await page.locator('.command').count(), 1);
    await page.getByRole('searchbox').fill('SELECT 199');
    await page.waitForFunction(() => document.querySelectorAll('.command').length === 1 && document.querySelector('.command').dataset.step === '199');
    await page.getByRole('combobox').selectOption('alice');
    await page.getByRole('heading', { name: 'No matching commands' }).waitFor();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    assert.equal(await page.locator('.command').count(), 100);

    const statuses = structuredClone(long);
    statuses.scenario = 'Browser qualification: command status names'; statuses.outcome = 'inconclusive';
    statuses.trace = statuses.trace.slice(0, 4);
    statuses.trace[0].completion = { transactionStatus: 'E', commandTags: [], rowCount: 0, error: { code: '40P01', message: 'Deadlock detected' } };
    statuses.trace[0].waits = [{ pid: 101, blockerPids: [102], waitEventType: 'Lock', waitEvent: 'transactionid' }];
    statuses.trace[1].waits = Array.from({ length: 2 }, () => ({ pid: 102, blockerPids: [101], waitEventType: 'Lock', waitEvent: 'transactionid' }));
    delete statuses.trace[2].completion; delete statuses.trace[2].completedAt;
    statuses.trace[3].completion.rowCount = 0;
    await upload('statuses.json', statuses);
    await page.getByRole('heading', { name: statuses.scenario, exact: true }).waitFor();
    const namedStatuses = [
      ['error and observed wait', /^Step 1, alice: SELECT 0\b.*Error.*40P01.*1 wait observation/],
      ['completion and observed waits', /^Step 2, bob: SELECT 1\b.*1 row\b.*2 wait observations/],
      ['incomplete command', /^Step 3, alice: SELECT 2\b.*Incomplete/],
      ['zero-row completion', /^Step 4, bob: SELECT 3\b.*0 rows/],
    ];
    const matchedStatuses = [];
    for (const [status, name] of namedStatuses) matchedStatuses.push({ status, matches: await page.getByRole('button', { name }).count() });
    assert.deepEqual(matchedStatuses, namedStatuses.map(([status]) => ({ status, matches: 1 })), 'Accessible command names expose recorded status alongside step, actor and SQL');
    const failedCommand = page.getByRole('button', { name: namedStatuses[0][1] });
    await failedCommand.focus(); await failedCommand.press('ArrowDown');
    assert.equal(await page.locator('.command[aria-pressed="true"]').getAttribute('data-step'), '1');
    assert.equal(await page.locator('.command[data-step="1"]').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.sql-full').textContent(), statuses.trace[1].sql);

    const empty = structuredClone(artifact);
    empty.outcome = 'inconclusive'; empty.trace = []; empty.actors = []; empty.plan = []; delete empty.failure;
    empty.reason = 'Stopped before recording a command';
    await upload('empty.json', empty);
    await page.getByRole('heading', { name: 'No commands were recorded' }).waitFor();
    assert.equal(await page.locator('.command').count(), 0);
    await upload('original.json', artifact);
    await page.getByRole('heading', { name: originalName, exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    return { checks: ['recorded fixture, source, runtime and startup identities', 'invalid schema preserved current record', 'invalid UTF-8 rejected', '16 MiB import cap', 'hostile text inert', 'download exact equality', '100-row pagination', 'keyboard page crossing', 'filtered original indices', 'accessible command outcomes and keyboard selection', 'empty evidence', 'no runtime errors', 'no external requests'], passed: true };
  } finally { page.off('pageerror', onError); page.off('request', onRequest); }
}

/** Actual driver metadata must never be presented as a completed SQL execution. */
export async function checkStagedReport(page, url, artifact, legacy) {
  const errors = [], requests = [];
  const onError = error => errors.push(error.message);
  const onRequest = request => { if (request.url() !== url) requests.push(request.url()); };
  page.on('pageerror', onError); page.on('request', onRequest);
  try {
    await page.goto(url);
    await page.getByRole('heading', { name: artifact.scenario, exact: true }).waitFor();
    const prefix = artifact.trace.find(step => step.completion?.kind === 'metadata' && step.completion.result === 'described');
    assert.ok(prefix);
    assert.equal(await page.locator(`.command[data-step="${prefix.index}"]`).and(page.getByRole('button', { name: /Describe.*Metadata received/ })).count(), 1, 'A description release is identifiable as metadata in its accessible name');
    await page.locator(`.command[data-step="${prefix.index}"]`).click();
    const inspector = page.locator('#inspector');
    assert.equal(await inspector.getByText('Description only', { exact: true }).count(), 1);
    assert.equal(await inspector.locator('dt').filter({ hasText: 'Rows affected / returned' }).count(), 0);
    assert.equal(await inspector.locator('dt').filter({ hasText: /^Transaction$/ }).count(), 0);
    assert.equal(await inspector.getByText('Parameters described', { exact: true }).count(), 1);
    assert.equal(await page.locator(`.command[data-step="${prefix.index}"]`).getByText('Metadata received', { exact: true }).count(), 1);
    assert.ok((await inspector.textContent()).includes('before parameter values are sent'));
    const execution = artifact.trace.find(step => step.actor === prefix.actor && step.connection === prefix.connection && step.prefixOrdinal === prefix.ordinal);
    assert.ok(execution);
    assert.equal(await page.locator(`.command[data-step="${execution.index}"]`).and(page.getByRole('button', { name: /Execute.*\d+ rows?/ })).count(), 1, 'The linked execution exposes its stage and completion in its accessible name');
    await page.locator(`.command[data-step="${execution.index}"]`).click();
    assert.equal(await inspector.getByText('Rows affected / returned', { exact: true }).count(), 1);
    await inspector.locator('.identity summary').click();
    assert.equal(await inspector.getByText(`Step ${prefix.index + 1}`, { exact: true }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Staged identity fits the viewport');
    assert.equal(await page.getByText(/undefined|NaN/).count(), 0);
    const upload = (name, value) => page.locator('#import-file').evaluate((element, data) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify(data.value)], data.name, { type: 'application/json' }));
      element.files = transfer.files; element.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name, value });
    const broken = structuredClone(artifact);
    broken.trace[execution.index].prefixOrdinal = execution.ordinal;
    await upload('broken-stage.json', broken);
    await page.getByRole('status').filter({ hasText: /Could not open broken-stage.json/ }).waitFor();
    assert.equal(await page.locator('#scenario').textContent(), artifact.scenario);
    await upload('legacy.json', legacy);
    await page.getByRole('heading', { name: legacy.scenario, exact: true }).waitFor();
    await upload('staged.json', artifact);
    await page.getByRole('heading', { name: artifact.scenario, exact: true }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const download = await downloadPromise, stream = await download.createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), artifact);
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    return { checks: ['real description metadata', 'accessible description and execution outcomes', 'no invented ready status', 'linked execution identity', 'mobile overflow', 'invalid stage rejected', 'legacy and staged imports', 'exact staged download', 'no errors or external requests'], passed: true };
  } finally { page.off('pageerror', onError); page.off('request', onRequest); }
}
