## 2026-10-18 - Provider reset prose and absolute precedence (senpi#3325, senpi#3348)

### What changed

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: prefer absolute reset prose over relative pacing, accept adjacent duration units and "reset after", and parse the known Z.ai timestamp phrase with its Beijing-time default and explicit-zone override.

### Why

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: a short retry hint hid the actual circuit reset; compact durations, "after" durations and Z.ai reset stamps otherwise fell back to default cooldowns.

### Why an extension could not handle it

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: internal credential and fallback cooldown consumers call this parser before extension error handling.

### Expected merge conflict zones

- `packages/coding-agent/src/core/credential-pool/reset-time.ts`: LOW, reset-prose expressions and absolute-versus-relative selection.

## 2026-10-07 - Retry a transient refresh on the same slot (senpi#2893)

### What changed

- `packages/coding-agent/src/core/credential-pool/classify.ts`: branded transient OAuth refresh returns `retry_same` with the existing attempt limit before status/message classification.

### Why

A healthy slot was failed or blocked when its refresh endpoint was temporarily unavailable.

### Why an extension could not handle it

Credential rotation invokes this classifier before an error reaches extension hooks.

### Expected merge conflict zones

- The first branch of `classifyCredentialFailure`; permanent login/account switching remains #2304's scope.
