import { appendFileSync } from 'node:fs';
import { withTlsTestServer } from '../../../scripts/tls-test-server.mjs';

const controller = new AbortController();
process.on('SIGTERM', () => {
  controller.abort(new Error('requested fixture cancellation'));
  process.send?.({ type: 'signal-received' });
});
try {
  await withTlsTestServer({ signal: controller.signal, onEvent: event => {
    appendFileSync(process.env.TLS_EVENTS, JSON.stringify(event) + '\n');
    process.send?.(event);
  } }, async () => { throw new Error('Cancelled fixture unexpectedly started its consumer'); });
  process.exitCode = 1;
} catch (error) {
  if (controller.signal.aborted && error.message === 'requested fixture cancellation') process.exitCode = 143;
  else { console.error(error); process.exitCode = 1; }
}
process.disconnect?.();
