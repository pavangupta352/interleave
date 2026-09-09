import { ARTIFACT_LIMITS, parseRunArtifact } from '../artifact-schema.js';
import type { RunResult, TraceStep } from '../types.js';

const PAGE_SIZE = 100;
const app = document.querySelector<HTMLDivElement>('#app')!;
let run: RunResult;
let replayCommand: string | null = null;
let actors: string[] = [];
let selected = 0;
let page = 0;
let query = '';
let actorFilter = '';
let filtered: TraceStep[] = [];
let importing = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const labels: Record<RunResult['outcome'], string> = { passed: 'Invariant held', violation: 'Invariant violated', 'actor-error': 'Actor failed', incompatible: 'Replay incompatible', inconclusive: 'Run inconclusive', 'harness-error': 'Harness failed' };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function button(text: string, action: () => void, className = 'button'): HTMLButtonElement {
  const result = node('button', className, text); result.type = 'button'; result.addEventListener('click', action); return result;
}
function announce(message: string, error = false): void {
  const status = document.querySelector<HTMLElement>('#status');
  if (!status) return;
  status.className = error ? 'status status-error' : 'status';
  status.textContent = message;
}
function formatMs(value: number): string { return `${Number(value.toFixed(2)).toLocaleString('en-US')} ms`; }
function actorNames(value: RunResult): string[] { return [...new Set([...value.actors.map(actor => actor.actor), ...value.trace.flatMap(step => [step.actor, ...step.available]), ...value.plan])]; }
function shortSql(value: string): string { return value.replace(/\s+/g, ' ').trim() || '(empty command)'; }
function stageLabel(step: TraceStep): string {
  return ({ complete: 'Complete query', describe: 'Describe', execute: 'Execute', recover: 'Recover' })[step.stage ?? 'complete'];
}
function setRun(value: RunResult, command: string | null): void {
  run = value; replayCommand = command; actors = actorNames(run); query = ''; actorFilter = ''; page = 0;
  selected = run.trace.find(step => step.completion?.error || step.waits.length)?.index ?? 0;
  document.title = `${run.scenario} · Interleave`;
  renderShell(); updateLedger(); renderInspector();
}
function renderShell(): void {
  const header = node('header', 'masthead');
  const brand = node('div', 'brand');
  brand.append(node('span', 'wordmark', 'interleave'), node('span', 'surface-name', 'Evidence record'));
  const actions = node('div', 'header-actions');
  const input = node('input'); input.type = 'file'; input.accept = '.json,application/json'; input.hidden = true; input.id = 'import-file';
  input.addEventListener('change', () => { const file = input.files?.[0]; if (file) void importFile(file); input.value = ''; });
  const importButton = button('Open artifact', () => input.click()); importButton.id = 'import-button';
  actions.append(importButton, button('Download JSON', download, 'button button-primary'), input); header.append(brand, actions);

  const main = node('main');
  const summary = node('section', `summary outcome-${run.outcome}`); summary.setAttribute('aria-labelledby', 'scenario');
  const heading = node('div', 'summary-heading');
  const title = node('h1', undefined, run.scenario); title.id = 'scenario';
  const outcome = node('span', `outcome ${run.outcome}`, labels[run.outcome]);
  heading.append(title, outcome);
  const subtitle = run.failure?.message ?? run.reason ?? (run.outcome === 'passed' ? 'The invariant held in this recorded execution.' : 'Inspect the recorded execution and its limits below.');
  const text = node('p', 'summary-message', subtitle);
  const metadata = node('div', 'metadata');
  for (const value of [`${run.trace.length.toLocaleString('en-US')} ${run.schemaVersion === 2 ? 'releases' : 'commands'}`, `${actors.length} actors`, `PostgreSQL ${run.environment.serverVersion}`, `${run.mode} mode`]) metadata.append(node('span', undefined, value));
  const cleanup = node('span', run.cleanup.complete ? 'cleanup-complete' : 'cleanup-incomplete', run.cleanup.complete ? 'Cleanup complete' : 'Cleanup incomplete'); metadata.append(cleanup);
  summary.append(heading, text, metadata);
  if (!run.cleanup.complete) summary.append(node('p', 'cleanup-warning', run.cleanup.error ?? 'Owned resource cleanup did not complete.'));

  const workspace = node('div', 'workspace');
  const evidence = node('section', 'evidence'); evidence.id = 'evidence'; evidence.tabIndex = -1; evidence.setAttribute('aria-labelledby', 'ledger-title');
  const toolbar = node('div', 'ledger-toolbar');
  const ledgerTitle = node('h2', undefined, 'Release order'); ledgerTitle.id = 'ledger-title';
  const filters = node('div', 'filters');
  const searchLabel = node('label', 'search-label'); searchLabel.append(node('span', 'sr-only', 'Search SQL, actors or errors'));
  const search = node('input'); search.type = 'search'; search.placeholder = 'Find SQL, actor or error'; search.id = 'search'; search.maxLength = 512;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = search.value.toLowerCase(); page = 0; updateLedger(); }, 100); });
  searchLabel.append(search);
  const selectLabel = node('label'); selectLabel.append(node('span', 'sr-only', 'Filter actor'));
  const select = node('select'); select.id = 'actor-filter';
  const all = node('option', undefined, 'All actors'); all.value = ''; select.append(all);
  for (const actor of actors) { const option = node('option', undefined, actor); option.value = actor; select.append(option); }
  select.addEventListener('change', () => { actorFilter = select.value; page = 0; updateLedger(); }); selectLabel.append(select);
  filters.append(searchLabel, selectLabel); toolbar.append(ledgerTitle, filters);
  const hint = node('p', 'ledger-hint', 'Select a command to inspect it. Use ↑ ↓ to move through the filtered order.');
  const selectionTools = node('div', 'selection-tools');
  const selectionLabel = node('span'); selectionLabel.id = 'selection-label';
  const inspect = button('Inspect selection', () => {
    const inspector = document.querySelector<HTMLElement>('#inspector')!;
    inspector.scrollIntoView({ block: 'start' }); inspector.focus({ preventScroll: true });
  }, 'text-button'); inspect.id = 'inspect-selection';
  selectionTools.append(selectionLabel, inspect);
  const ledger = node('div', 'ledger'); ledger.id = 'ledger';
  const pagination = node('div', 'pagination'); pagination.id = 'pagination';
  const scope = node('p', 'scope-note', `${run.schemaVersion === 2 ? 'Each row is a scheduled release. A query may have separate description and execution stages.' : 'Each row is a client command released to PostgreSQL.'} PostgreSQL controls execution and lock resumption. This record does not prove the absence of other races.`);
  evidence.append(toolbar, hint, selectionTools, ledger, pagination, scope);
  const inspector = node('aside', 'inspector'); inspector.id = 'inspector'; inspector.setAttribute('aria-label', 'Selected command evidence'); inspector.tabIndex = -1;
  workspace.append(evidence, inspector); main.append(summary, workspace);
  const footer = node('footer', 'footer');
  const details = node('details', 'record-details'); const detailTitle = node('summary', undefined, 'Record & replay details');
  const recordBody = node('div', 'record-body');
  const info = node('dl', 'facts');
  addFact(info, 'Started', run.startedAt); addFact(info, 'Runtime', run.environment.nodeVersion); addFact(info, 'Duration', formatMs(run.durationMs));
  addFact(info, 'Run limits', `${run.limits.maxSteps.toLocaleString('en-US')} steps · ${formatMs(run.limits.timeoutMs)}`);
  addFact(info, 'Recorded plan', run.plan.length ? run.plan.join(' → ') : 'Fair scheduling; no explicit choices');
  const fixture = run.environment.fixture;
  addFact(info, 'Fixture profile', fixture?.profile ?? 'Not recorded in this artifact');
  if (fixture) {
    addFact(info, 'Fixture identity', fixture.fingerprint);
    addFact(info, 'Fixture size', `${fixture.counts.objects.toLocaleString('en-US')} ${fixture.counts.objects === 1 ? 'object' : 'objects'} · ${fixture.counts.rows.toLocaleString('en-US')} ${fixture.counts.rows === 1 ? 'row' : 'rows'}`);
  }
  const source = run.environment.source;
  addFact(info, 'Source profile', source?.profile ?? 'Not recorded in this artifact');
  if (source) {
    addFact(info, 'Source identity', source.fingerprint);
    addFact(info, 'Entry file', source.entry);
    addFact(info, 'Declared data inputs', source.includes.length
      ? `${source.includes.slice(0, 10).join(' · ')}${source.includes.length > 10 ? ` · ${source.includes.length - 10} more in JSON` : ''}`
      : 'No additional paths declared');
    addFact(info, 'Application files', `${source.components.source.fileCount.toLocaleString('en-US')} files · ${source.components.source.fingerprint}`);
    addFact(info, 'Installed dependencies', `${source.components.dependencies.packages.length.toLocaleString('en-US')} packages · ${source.components.dependencies.fingerprint}`);
    addFact(info, 'Harness runtime', `${source.components.runtime.mode} mode · ${source.components.runtime.fingerprint}`);
  }
  addFact(info, 'Connection profile', `${run.limits.maxConnectionsPerActor ?? 1} physical ${(run.limits.maxConnectionsPerActor ?? 1) === 1 ? 'connection' : 'connections'} per actor; one live command producer`);
  addFact(info, 'Protocol profile', run.limits.protocolProfile ?? 'sync-cycle-v1');
  addFact(info, 'Actor startups', run.connections === undefined ? 'Not recorded in this artifact' : `${run.connections.length.toLocaleString('en-US')} recorded`);
  for (const connection of run.connections ?? []) addFact(info, `${connection.actor} · ${connection.connection}`, connection.fingerprint);
  recordBody.append(info);
  if (replayCommand) {
    const command = node('pre', 'replay-command', replayCommand);
    const copy = button('Copy replay command', () => void copyText(replayCommand!, copy)); recordBody.append(command, copy);
  } else recordBody.append(node('p', 'muted', 'To replay, use the original trusted scenario with this JSON artifact. This HTML viewer does not execute scenarios.'));
  details.append(detailTitle, recordBody);
  footer.append(details, node('p', 'privacy-note', 'Local evidence · No network requests. SQL and selected observations may contain private data.'));
  const status = node('p', 'status'); status.id = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  app.replaceChildren(header, main, footer, status);
}
function updateLedger(): void {
  filtered = run.trace.filter(step => (!actorFilter || step.actor === actorFilter) && (!query || `${step.actor}\n${step.sql}\n${step.completion?.error?.message ?? ''}\n${step.completion?.error?.code ?? ''}`.toLowerCase().includes(query)));
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const subset = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const ledger = document.querySelector<HTMLDivElement>('#ledger')!;
  if (!subset.length) {
    const empty = node('div', 'empty'); empty.append(node('h3', undefined, run.trace.length ? 'No matching commands' : 'No commands were recorded'), node('p', undefined, run.trace.length ? 'Try a different search or include all actors.' : run.reason ?? 'This execution ended before a command was recorded.'));
    if (query || actorFilter) empty.append(button('Clear filters', () => { query = ''; actorFilter = ''; (document.querySelector('#search') as HTMLInputElement).value = ''; (document.querySelector('#actor-filter') as HTMLSelectElement).value = ''; updateLedger(); }));
    ledger.replaceChildren(empty);
  } else {
    const table = node('table', `schedule lanes-${actors.length}`); table.setAttribute('aria-label', 'Recorded command release order');
    const head = node('thead'); const headings = node('tr');
    for (const [index, title] of ['Step', ...actors, 'Released'].entries()) {
      const th = node('th', index === 0 ? 'step-column' : index === actors.length + 1 ? 'time-column' : 'actor-heading', title); th.scope = 'col'; headings.append(th);
    }
    const mobileHeading = node('th', 'mobile-command-heading', 'Command / actor'); mobileHeading.scope = 'col'; headings.insertBefore(mobileHeading, headings.lastChild);
    head.append(headings); table.append(head); const body = node('tbody');
    const focusIndex = subset.some(step => step.index === selected) ? selected : subset[0]!.index;
    for (const step of subset) {
      const row = node('tr', step.index === selected ? 'selected-row' : ''); row.dataset.index = String(step.index);
      const number = node('th', 'step-number', String(step.index + 1).padStart(2, '0')); number.scope = 'row'; row.append(number);
      for (const actor of actors) {
        const cell = node('td', actor === step.actor ? 'actor-cell active-cell' : 'actor-cell vacant-cell');
        if (actor === step.actor) {
          const command = button('', () => selectStep(step.index), 'command'); command.dataset.step = String(step.index); command.tabIndex = step.index === focusIndex ? 0 : -1;
          command.setAttribute('aria-pressed', String(step.index === selected)); command.setAttribute('aria-label', `Step ${step.index + 1}, ${step.actor}: ${shortSql(step.sql).slice(0, 160)}`);
          command.setAttribute('aria-controls', 'inspector');
          command.append(node('span', 'mobile-actor', step.actor), node('code', 'sql-preview', shortSql(step.sql)));
          const summary = node('span', 'command-summary');
          summary.append(node('span', 'protocol', step.protocol === 'extended' ? step.stage && step.stage !== 'complete' ? 'Extended stage' : 'Extended cycle' : 'Simple query'));
          if (step.completion?.error) summary.append(node('span', 'command-error', step.completion.error.code));
          else if (step.waits.length) summary.append(node('span', 'command-wait', `${step.waits.length} wait ${step.waits.length === 1 ? 'observation' : 'observations'}`));
          else if (step.completion?.kind === 'metadata') summary.append(node('span', undefined, 'Metadata received'));
          else summary.append(node('span', undefined, step.completion ? `${step.completion.rowCount} ${step.completion.rowCount === 1 ? 'row' : 'rows'}` : 'Incomplete'));
          if (step.stage && step.stage !== 'complete') summary.prepend(node('span', undefined, stageLabel(step)));
          command.append(summary); command.addEventListener('keydown', navigate); cell.append(command);
        }
        row.append(cell);
      }
      row.append(node('td', 'release-time', formatMs(step.releasedAt))); body.append(row);
    }
    table.append(body); ledger.replaceChildren(table);
  }
  const pagination = document.querySelector<HTMLDivElement>('#pagination')!;
  const count = node('span', 'record-count', filtered.length ? `${(page * PAGE_SIZE + 1).toLocaleString('en-US')}–${Math.min((page + 1) * PAGE_SIZE, filtered.length).toLocaleString('en-US')} of ${filtered.length.toLocaleString('en-US')} matching · ${run.trace.length.toLocaleString('en-US')} recorded` : `0 matching · ${run.trace.length.toLocaleString('en-US')} recorded`);
  const controls = node('div', 'page-controls');
  const previous = button('Previous', () => { page--; updateLedger(); focusFirst(); }); previous.disabled = page === 0;
  const next = button('Next', () => { page++; updateLedger(); focusFirst(); }); next.disabled = (page + 1) * PAGE_SIZE >= filtered.length;
  controls.append(previous, next); pagination.replaceChildren(count, controls);
  announce(`${filtered.length} of ${run.trace.length} commands match. Original step numbers are preserved.`);
}
function focusFirst(): void {
  const command = document.querySelector<HTMLButtonElement>('.command');
  if (!command) return;
  command.scrollIntoView({ block: 'start', inline: 'nearest' });
  const stickyHeight = document.querySelector('.selection-tools')!.getBoundingClientRect().height;
  window.scrollBy({ top: -stickyHeight - 12 });
  command.focus({ preventScroll: true });
}
function selectStep(index: number, focus = false): void {
  selected = index;
  for (const command of document.querySelectorAll<HTMLButtonElement>('.command')) {
    const active = Number(command.dataset.step) === index;
    command.setAttribute('aria-pressed', String(active)); command.tabIndex = active ? 0 : -1; command.closest('tr')?.classList.toggle('selected-row', active);
    if (active && focus) command.focus({ preventScroll: true });
  }
  renderInspector(); announce(`Step ${index + 1}, ${run.trace[index]!.actor} selected. Command evidence updated.`);
}
function navigate(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const position = filtered.findIndex(step => step.index === Number((event.currentTarget as HTMLButtonElement).dataset.step));
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
  const index = filtered[next]!.index;
  if (page !== Math.floor(next / PAGE_SIZE)) { page = Math.floor(next / PAGE_SIZE); updateLedger(); }
  selectStep(index, true); document.querySelector<HTMLButtonElement>(`.command[data-step="${index}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function addFact(list: HTMLDListElement, label: string, value: string): void { const group = node('div'); group.append(node('dt', undefined, label), node('dd', undefined, value)); list.append(group); }
function renderInspector(): void {
  const inspector = document.querySelector<HTMLElement>('#inspector')!;
  const step = run.trace[selected];
  document.querySelector('#selection-label')!.textContent = step ? `Selected: step ${step.index + 1} · ${step.actor}` : 'No command selected';
  (document.querySelector('#inspect-selection') as HTMLButtonElement).disabled = !step;
  const header = node('div', 'inspector-heading'); header.append(node('h2', undefined, step ? `Step ${step.index + 1}` : 'Execution evidence'));
  if (step) header.append(node('span', 'actor-label', step.actor));
  const contents: HTMLElement[] = [header];
  if (step) contents.push(button('Back to selected command', () => {
    query = ''; actorFilter = ''; (document.querySelector('#search') as HTMLInputElement).value = ''; (document.querySelector('#actor-filter') as HTMLSelectElement).value = '';
    page = Math.floor(step.index / PAGE_SIZE); updateLedger();
    const command = document.querySelector<HTMLButtonElement>(`.command[data-step="${step.index}"]`)!;
    command.scrollIntoView({ block: 'center', inline: 'nearest' }); command.focus({ preventScroll: true });
  }, 'text-button back-to-command'));
  if (step) {
    const sql = node('section', 'inspector-section'); const sqlHeading = node('div', 'section-heading'); sqlHeading.append(node('h3', undefined, 'SQL sent to PostgreSQL'));
    const copy = button('Copy SQL', () => void copyText(step.sql, copy), 'text-button'); sqlHeading.append(copy);
    const code = node('pre', 'sql-full'); code.tabIndex = 0; code.append(node('code', undefined, step.sql || '(empty command)')); sql.append(sqlHeading, code);
    if (step.protocol === 'extended') sql.append(node('p', 'detail-note', step.stage === 'describe'
      ? 'This release describes the query before parameter values are sent. Values are bound into the later execution fingerprint.'
      : step.stage === 'recover' ? 'This release sends Sync after the description error. The SQL above identifies the failed query.'
        : 'Parameter values are bound into the command fingerprint; they are not displayed as query text.'));
    contents.push(sql);
    const completion = node('section', 'inspector-section'); completion.append(node('h3', undefined, 'PostgreSQL completion'));
    const facts = node('dl', 'facts');
    addFact(facts, 'Status', step.completion?.error ? `Error · ${step.completion.error.code}` : step.completion ? 'Completed' : 'Not recorded');
    if (step.completion?.kind === 'metadata') {
      addFact(facts, 'Boundary', 'Description only');
      if (step.completion.result === 'described') {
        addFact(facts, 'Parameters described', String(step.completion.parameterCount));
        addFact(facts, 'Result columns', step.completion.resultShape === 'no-data' ? 'No result columns (NoData)' : String(step.completion.columnCount));
      }
    } else if (step.completion) {
      addFact(facts, 'Command tags', step.completion.commandTags.join(' · ') || 'None'); addFact(facts, 'Rows affected / returned', String(step.completion.rowCount));
      addFact(facts, 'Transaction', ({ I: 'Idle', T: 'In transaction', E: 'Failed transaction' })[step.completion.transactionStatus]);
    }
    addFact(facts, 'Released', formatMs(step.releasedAt)); if (step.completedAt !== undefined) addFact(facts, 'Completed', formatMs(step.completedAt));
    completion.append(facts); if (step.completion?.error) completion.append(node('pre', 'error-message', step.completion.error.message)); contents.push(completion);
    const waits = node('section', 'inspector-section'); waits.append(node('h3', undefined, 'Observed waits'));
    if (!step.waits.length) waits.append(node('p', 'detail-note', 'No scheduler wait observation was recorded for this command.'));
    for (const wait of step.waits) {
      const item = node('div', 'wait-observation'); item.append(node('p', 'wait-title', `${wait.waitEventType} · ${wait.waitEvent}`));
      const blockerActors = [...new Set(wait.blockerPids.flatMap(pid => run.trace.filter(candidate => candidate.backendPid === pid).map(candidate => candidate.actor)))];
      item.append(node('p', undefined, `Blocked by ${blockerActors.join(', ')} (backend ${wait.blockerPids.join(', ')}).`)); waits.append(item);
    }
    contents.push(waits);
    const identity = node('details', 'identity'); identity.append(node('summary', undefined, 'Command identity'));
    const identityFacts = node('dl', 'facts'); addFact(identityFacts, 'Protocol', step.protocol); addFact(identityFacts, 'Connection / ordinal', `${step.connection} / ${step.ordinal} (zero-based)`);
    if (step.stage) {
      addFact(identityFacts, 'Stage / cycle', `${stageLabel(step)} / ${step.cycle! + 1}`);
      const prefix = run.trace.find(candidate => candidate.actor === step.actor && candidate.connection === step.connection && candidate.ordinal === step.prefixOrdinal);
      if (prefix) addFact(identityFacts, 'Description release', `Step ${prefix.index + 1}`);
    }
    addFact(identityFacts, 'Backend PID', String(step.backendPid)); addFact(identityFacts, 'Available actors', step.available.join(', ')); addFact(identityFacts, 'Fingerprint', step.fingerprint); identity.append(identityFacts); contents.push(identity);
  } else contents.push(node('p', 'detail-note', 'There is no command to inspect. Review the execution outcome and actor observations.'));
  const observations = node('details', 'observations'); observations.append(node('summary', undefined, 'Selected actor observations'));
  observations.append(node('p', 'detail-note', 'Values explicitly returned by scenario actors. Database result rows are not automatically captured.'));
  for (const actor of run.actors) {
    const result = node('section', 'actor-result'); result.append(node('h3', undefined, `${actor.actor} · ${actor.status}`));
    result.append(node('pre', undefined, actor.status === 'rejected' ? actor.error ?? '' : actor.value === undefined ? 'No observation returned' : JSON.stringify(actor.value, null, 2))); observations.append(result);
  }
  if (!run.actors.length) observations.append(node('p', 'detail-note', 'No actor observations recorded.'));
  contents.push(observations); inspector.replaceChildren(...contents);
}
async function importFile(file: File): Promise<void> {
  if (importing) return;
  importing = true; const trigger = document.querySelector<HTMLButtonElement>('#import-button')!; trigger.disabled = true; trigger.textContent = 'Opening…';
  try {
    if (file.size > ARTIFACT_LIMITS.maxBytes) throw new Error('Artifact exceeds the 16 MiB limit');
    const bytes = await file.arrayBuffer(); if (bytes.byteLength > ARTIFACT_LIMITS.maxBytes) throw new Error('Artifact exceeds the 16 MiB limit');
    const parsed = parseRunArtifact(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    clearTimeout(searchTimer); setRun(parsed, null); announce(`Opened ${file.name}. ${parsed.trace.length} commands recorded.`);
  } catch (error) { announce(`Could not open ${file.name}: ${error instanceof Error ? error.message : 'Invalid artifact'}. Choose a valid Interleave JSON artifact; the current record is unchanged.`, true); }
  finally { importing = false; const current = document.querySelector<HTMLButtonElement>('#import-button')!; current.disabled = false; current.textContent = 'Open artifact'; }
}
function download(): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(run)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = 'interleave-run.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); announce('Downloaded the exact current JSON record.');
}
async function copyText(value: string, trigger: HTMLButtonElement): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const area = node('textarea', 'clipboard-buffer'); area.value = value; document.body.append(area); area.select();
      try { if (!document.execCommand('copy')) throw new Error('Clipboard access is unavailable'); } finally { area.remove(); trigger.focus(); }
    }
    announce('Copied to clipboard.');
  } catch { announce('Clipboard access is unavailable. Select the displayed text and copy it manually.', true); }
}
try {
  const payload = JSON.parse(document.querySelector('#run-data')!.textContent!);
  setRun(parseRunArtifact(payload.run), typeof payload.replayCommand === 'string' ? payload.replayCommand : null);
} catch (error) {
  app.replaceChildren(node('h1', 'boot-message', 'This evidence record could not be opened'), node('p', 'boot-message', error instanceof Error ? error.message : 'Invalid artifact'));
}
