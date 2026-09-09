import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunArtifact, validateArtifactWriteOptions } from './artifact-schema.js';
import type { RunResult } from './types.js';

export interface ReportOptions {
  /** A display-only replay command. It is never executed by the report. */
  replayCommand?: string;
}
export interface WriteReportOptions extends ReportOptions { overwrite?: boolean }

let resources: Promise<{ script: string; style: string }> | undefined;
function loadResources(): Promise<{ script: string; style: string }> {
  return resources ??= (async () => {
    const style = await readFile(new URL('./report/styles.css', import.meta.url), 'utf8');
    if (import.meta.url.endsWith('.ts')) {
      const { build } = await import('esbuild');
      const output = await build({ entryPoints: [fileURLToPath(new URL('./report/browser.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true, legalComments: 'none' });
      return { style, script: output.outputFiles[0]!.text };
    }
    return { style, script: await readFile(new URL('./report/browser.bundle.js', import.meta.url), 'utf8') };
  })().catch(error => { resources = undefined; throw error; });
}

/** Create an offline evidence viewer. Recorded SQL and observations remain private, exact data. */
export async function renderReport(run: RunResult, options: ReportOptions = {}): Promise<string> {
  const validated = parseRunArtifact(run);
  const command = validateOptions(options);
  const { script, style } = await loadResources();
  const data = JSON.stringify({ run: validated, replayCommand: command }).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const digest = (value: string): string => createHash('sha256').update(value).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'none'`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="light"><title>${escapeHtml(validated.scenario)} · Interleave</title><style>${style}</style></head>
<body><a class="skip-link" href="#evidence">Skip to evidence</a><div id="app"><p class="boot-message">Opening the local evidence record…</p></div><noscript><p>This report needs JavaScript to inspect the embedded evidence. No network connection is used.</p></noscript><script id="run-data" type="application/json">${data}</script><script>${script}</script></body></html>\n`;
}

/** Atomically write a private report. Existing destinations are refused unless overwrite is explicit. */
export async function writeReport(path: string, run: RunResult, options: WriteReportOptions = {}): Promise<void> {
  if (typeof path !== 'string' || !path.length) throw new TypeError('Report path must be a non-empty string');
  validateOptions(options, true);
  const writeOptions = validateArtifactWriteOptions(options.overwrite === undefined ? {} : { overwrite: options.overwrite });
  const html = await renderReport(run, options.replayCommand === undefined ? {} : { replayCommand: options.replayCommand });
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let exists = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    exists = true;
    try { await handle.writeFile(html, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (writeOptions.overwrite) { await rename(temporary, path); exists = false; }
    else {
      try { await link(temporary, path); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`Report already exists; pass { overwrite: true } to replace it: ${path}`);
        throw error;
      }
      await unlink(temporary); exists = false;
    }
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { if (exists) await unlink(temporary).catch(() => undefined); }
}
function validateOptions(options: ReportOptions, allowOverwrite = false): string | null {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError('Report options must be a plain object');
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'replayCommand' && !(allowOverwrite && key === 'overwrite')) throw new TypeError(`Unknown report option: ${String(key)}`);
    if (!('value' in Object.getOwnPropertyDescriptor(options, key)!)) throw new TypeError('Report options must not contain accessors');
  }
  if (options.replayCommand === undefined) return null;
  if (typeof options.replayCommand !== 'string' || options.replayCommand.length > 8192 || /[\x00-\x1f\x7f]/.test(options.replayCommand)) throw new TypeError('Replay command must be a single line of at most 8192 characters');
  return options.replayCommand;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
