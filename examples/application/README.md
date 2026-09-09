# An application operation with an injected client

`counter.mjs` is a deliberately unsafe read-then-write operation. `scenario.mjs`
imports it unchanged, gives each concurrent caller a real node-postgres Client,
and asserts that two increments leave a counter at two.

Follow the [application guide](../../docs/application-guide.md) for complete
commands. It copies both files from the built package into an ordinary application
installed through the [local-archive route](../../docs/getting-started.md#install-this-development-build-into-an-application).
The scenario's public Interleave import resolves that app-installed package.
Running it directly under Interleave's own package root would use a self-reference
alias, which the source capture profile rejects.

The [CI guide](../../docs/ci.md) retains the original failure, changes only the
business operation to an atomic update, and checks the changed behavior. This
is a constructed teaching example, not a historical application defect.
