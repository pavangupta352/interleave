---
name: Bug report
about: Report reproducible incorrect behavior
title: ""
labels: ""
assignees: ""
---

Remove credentials, private SQL, production data and other sensitive values. A small synthetic reproduction is preferred. Do not attach an artifact that contains private information; describe the relevant facts in the issue instead. For a security vulnerability, stop here and follow [SECURITY.md](https://github.com/pavangupta352/interleave/blob/main/SECURITY.md).

## Environment

- Interleave version:
- Node.js version:
- PostgreSQL version and fixture profile:
- Database driver and version:
- Operating system:

## Recorded outcome

Which outcome did Interleave report (`passed`, `violation`, `actor-error`, `harness-error`, `inconclusive` or `incompatible`)? Include the command's exit code and the cleanup status.

## Expected and actual behavior

What did you expect to happen, and what happened instead? Include the exact error text after removing sensitive values.

## Reproduction

Provide the smallest scenario, plan and command sequence that reproduces the problem. Paste short synthetic code or link to a public repository when possible. State whether the problem repeats with exact replay.

## Cleanup

Did Interleave report `Cleanup complete`? If cleanup was incomplete, list only the uniquely named test resources that remain and how you verified them. Do not include credentials or a production database URL. Uploading a run artifact or HTML report is optional; review it first because it may contain SQL, errors and selected observations.
