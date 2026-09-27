// A hand-written synchronization baseline for the historical cases.
//
// It wraps node-postgres's Client.prototype.query for the duration of one
// trial. The first query from each client whose SQL text matches `match` runs
// normally against PostgreSQL, but its result is withheld from the caller until
// every actor has either reached that point or settled. Then all withheld
// results are delivered together. SQL text, parameters and the library's code
// are unchanged; only the timing of result delivery is controlled.
//
// This is the kind of test-only instrumentation a developer writes after
// learning which statement boundary matters. It requires that knowledge and a
// case-specific matcher, and it gates one point only.

export function installResultBarrier(pg, { match, parties }) {
  const Client = pg?.Client;
  if (typeof Client?.prototype?.query !== 'function') throw new TypeError('Expected the node-postgres module');
  if (!Number.isInteger(parties) || parties < 2) throw new TypeError('A barrier needs at least two parties');
  const original = Client.prototype.query;
  const gatedClients = new WeakSet();
  const waiting = [];
  const started = performance.now();
  const events = [];
  let arrived = 0;
  let settledWithoutArriving = 0;
  let released = false;

  const now = () => Math.round((performance.now() - started) * 1000) / 1000;
  function releaseIfComplete() {
    if (released || arrived + settledWithoutArriving < parties) return;
    released = true;
    events.push({ event: 'release', atMs: now(), arrived, settledWithoutArriving });
    for (const resume of waiting.splice(0)) resume();
  }
  function arrive() {
    arrived += 1;
    events.push({ event: 'arrive', atMs: now() });
    const resumed = new Promise(resolve => waiting.push(resolve));
    releaseIfComplete();
    return resumed;
  }

  Client.prototype.query = function query(config, values, callback) {
    const text = typeof config === 'string' ? config : config?.text;
    if (released || typeof text !== 'string' || gatedClients.has(this) || !match(text)) {
      return original.apply(this, arguments);
    }
    gatedClients.add(this);
    const args = [...arguments];
    const callbackIndex = args.findIndex(argument => typeof argument === 'function');
    if (callbackIndex >= 0) {
      const deliver = args[callbackIndex];
      args[callbackIndex] = function withheld(...results) {
        void arrive().then(() => deliver.apply(this, results));
      };
      return original.apply(this, args);
    }
    if (typeof config?.submit === 'function') throw new Error('The result barrier does not support submittable queries');
    return original.apply(this, args).then(
      async result => { await arrive(); return result; },
      async error => { await arrive(); throw error; },
    );
  };

  return {
    /** Call once for each actor that settles; an actor that never reaches the gate releases the others. */
    actorSettled() {
      if (released) return;
      // An actor waiting at the barrier cannot settle before release, so every
      // settlement observed here is from an actor that did not arrive.
      settledWithoutArriving += 1;
      events.push({ event: 'settled-before-gate', atMs: now() });
      releaseIfComplete();
    },
    uninstall() {
      Client.prototype.query = original;
      for (const resume of waiting.splice(0)) resume();
    },
    summary() {
      return { arrived, settledWithoutArriving, released, events: [...events] };
    },
  };
}
