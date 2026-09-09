# Security

Interleave runs trusted scenario code and owns disposable PostgreSQL databases.
Process supervision manages execution and cleanup; it is not a sandbox for
untrusted application code. Use a dedicated test PostgreSQL server and credentials.

Run artifacts and HTML reports preserve SQL, error messages and observations
selected by the scenario. Those values may contain secrets. Review evidence before
publishing it. Imported JSON is data: artifact verification and the offline viewer
must never execute a scenario, fetch remote resources or treat SQL as HTML.

Report security issues privately to Pavan Gupta at
[pavan.gupta.352@gmail.com](mailto:pavan.gupta.352@gmail.com). Include reproduction
steps, affected versions and the impact you observed. Avoid sending production
credentials or private datasets; a small synthetic reproduction is preferable.

There is no stable release yet. Security and compatibility qualification is ongoing;
unsupported profiles should fail explicitly rather than produce passing evidence.
