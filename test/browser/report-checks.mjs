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
    return { checks: ['recorded fixture and startup identities', 'invalid schema preserved current record', 'invalid UTF-8 rejected', '16 MiB import cap', 'hostile text inert', 'download exact equality', '100-row pagination', 'keyboard page crossing', 'filtered original indices', 'empty evidence', 'no runtime errors', 'no external requests'], passed: true };
  } finally { page.off('pageerror', onError); page.off('request', onRequest); }
}
