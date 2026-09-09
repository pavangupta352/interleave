# Offline evidence reports

Create a standalone HTML viewer from a saved run:

```sh
interleave report failure.interleave.json --out failure.html
```

Open `failure.html` in a browser. It contains its own styles, scripts and validated
record, uses no external resources, and needs no server or database connection.
Writing or opening a report never executes a scenario. Existing destinations are
refused; `--force` explicitly permits atomic replacement. Files are written with
private permissions where supported by the operating system.

The release-order ledger keeps the original command indices. Each actor has a
column on desktop; narrow screens show a single command column with actor names.
Select a row to inspect exact SQL, protocol, command tags, affected/returned row
count, SQLSTATE, transaction state and recorded lock observations. Parameter bytes
contribute to command fingerprints but are not displayed as query text.

Use the arrow keys to move through the filtered order; Home and End select its
first and last command, including across page boundaries. The ledger renders at
most 100 commands per page. Search and actor filters preserve the original step
numbers. **Inspect selection** moves keyboard focus to the detail panel. Narrow
screens also offer **Back to selected command**.

Recorded waits identify the observed PostgreSQL wait type and blocking actors.
An absent wait observation means none was recorded by the scheduler, not that
PostgreSQL never waited. Release and completion times are measurements, not a
claim that the proxy controls execution inside PostgreSQL.

**Selected actor observations** shows only values explicitly returned by actors;
it is separate from protocol completion summaries. Database result rows are not
automatically captured. Failed cleanup and incomplete executions remain visible.

**Record & replay details** includes the fixture capture profile, its digest and
size, and recorded actor startup digests. Older development records explicitly
show missing identities. These hashes identify captured inputs without displaying
the starting rows or raw connection options.

**Open artifact** imports a local JSON run after applying the same validator used
by the library and CLI. Invalid UTF-8, unsupported schemas and files over 16 MiB
are rejected while the current record remains intact. **Download JSON** saves the
current exact record. SQL, messages and actor observations are rendered as text;
they cannot supply executable HTML or remote resources to the viewer.

Artifacts and reports can contain private application data. Review the contents
before sharing. The viewer does not silently rewrite evidence or redact values.
A report is an inspection surface; retain the trusted scenario and use the CLI
or a [portable regression export](regressions.md) to execute a replay.

The library exposes `renderReport(run, { replayCommand? })` and
`writeReport(path, run, { replayCommand?, overwrite? })`. The optional replay
command is a single line of display-only text. The viewer can copy it but never
executes it; importing another artifact clears that command.
