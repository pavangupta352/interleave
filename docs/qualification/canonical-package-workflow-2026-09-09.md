# Installed package workflow qualification

On September 9, 2026, the same retained Interleave archive completed the public
CLI workflow in two fresh applications: Node.js 22.18.0 / npm 10.9.3 and Node.js
24.7.0 / npm 11.5.1. Both used node-postgres 8.23.0 and PostgreSQL 16.15.
This is a local candidate qualification; Interleave remains unreleased.

## Exact candidate

| Identity | Value |
| --- | --- |
| Source commit | `4b589dbac81eeef7bdabf461b105dc9bb29113b6` |
| Package | `@pavangupta352/interleave@0.1.0-dev.0` |
| Original npm archive | `pavangupta352-interleave-0.1.0-dev.0.tgz` |
| Archive size / files | 1,771,133 bytes / 261 files |
| Archive SHA-256 | `9a054b2d239d1748e5f85e39763b9c86ad55f0eedf9946781c3b56e29cb2eaa3` |
| Release manifest SHA-256 | `c457c623f28a4d1f143b27a057505f2cfeb00f92dbfba63612268c3c66c475da` |
| PostgreSQL image | `postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94` |

[Release preparation](../releasing.md) built the committed source twice,
compared both original npm archives and their complete file inventories, and
checked a clean installed import, CLI and scaffold. The database workflow below
used that exact archive throughout. It did not use the working checkout's
runtime or repack the candidate. The original release manifest retains its
preparation-only acceptance scope; this record supplies the later execution
evidence.

## Executed public workflow

Each Node version installed the archive into a fresh bootstrap application and
used its public `init` command. The resulting application installed that same
archive and `pg@8.23.0` before recording. The generated `scenario.mjs` remained
unchanged: 901 bytes, SHA-256
`4e5c222f1b90fa852346d6e3045608fe7983650d6f7b0d01c8b2ff964f17c4a8`.
Both application locks were byte-identical and remained unchanged.

| Command | Observed result on both Node versions |
| --- | --- |
| `doctor` | Exit 0, passed, complete cleanup |
| `run` with `alice,bob,alice,bob` and `--max-runs 1` | Exit 1, one completed run, one violation, stopped on failure, no pending prefixes |
| Exact `replay` | Exit 1, same violation and bound inputs |
| `minimize` | Exit 1, four choices reduced to zero in four attempts, locally minimal, same failure |
| `report` | Exit 0, standalone HTML written from the minimized artifact |
| `export --runtime-archive` | Exit 0, all 20 declared export files verified; bundled runtime identical to the retained archive |
| Export's `install.mjs` | Exit 0, original source and complete installed identity verified |
| Export's emitted exact replay command | Exit 1, same minimized violation and bound inputs |

The export installer used an initially empty private cache and
`https://unavailable.invalid/` as its registry. Initial application installation
used ordinary npm dependency resolution. The exported `run.json` was
byte-identical to the minimized artifact. Each version recorded and replayed
its own runs; a Node 24 artifact was not replayed on Node 22.

All four failure artifacts in each workflow retained the same fixture,
source, dependency, runtime, startup, command and failure identities. Their
four released SQL units were two reads followed by two updates. The failure
fingerprint was
`5e22d27be75658a83ca998232a5c341b032b3ec61073248b2f8199fbb2276d70`.
The Node versions are recorded separately in `environment.nodeVersion`;
equal source and dependency bytes correctly have equal byte identities.

## Installed report browser checks

The two retained HTML reports were served unchanged on loopback and checked in
Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 using Playwright 1.63.0.
Both reports passed all 12 shared viewer check groups at 1440×1000 and 390×844:
12 report/browser/viewport combinations. Checks covered recorded identities,
invalid schema and UTF-8, the import size cap, inert hostile text, exact JSON
download, pagination, keyboard navigation, filtering, empty evidence and absence
of page errors or external requests.

Constructed imports exercised the viewer only; the original four-command
artifact was restored before each screenshot. Representative desktop and mobile
captures were inspected for layout and clipping. Independent verification
checked the separate 24-file browser evidence index, every screenshot hash and
the unchanged original workflow index. All 12 pages, three browsers and the
loopback server closed; an independent port check found no listener. These
ordinary-protocol reports do not add staged-protocol browser coverage.

## Evidence and cleanup limits

Independent verification re-read the raw command records and artifacts, checked
all 280 indexed evidence files, compared every exported file's bytes and hash,
and confirmed the canonical archive remained unchanged. Both workflows had
eight exact database CREATE/DROP pairs in actual PostgreSQL logs. All retained
run artifacts reported complete cleanup. Three uniquely owned containers and
their volumes were removed, independent exact-ID inspections found none, and
all 69 recorded child process IDs were absent.

A live catalog absence query before container removal was **not executed**.
Two private postprocessing errors reached cleanup before that planned query:
one used the wrong export manifest filename, and one used the wrong Node-version
field name. The actual retained artifacts verified under their documented
names. Successful product commands were not repeated. An earlier container
readiness race stopped before any product command; its exact container was
also removed. These orchestration findings are preserved in the private
evidence record.

This constructed lost-update scaffold qualifies the installed CLI workflow.
It does not qualify historical library defects, comparative baselines, a public
registry or GitHub download, a stable tag, or a later source commit. The
[acceptance checklist](../plans/implementation.md) tracks those separate gates.
