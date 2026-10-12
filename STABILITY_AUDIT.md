# DARKNOTE — Whole Bot Stability Audit

Date: 2026-09-14

## Result

The source was audited without replacing the existing architecture. Baileys connection/session handling, command dispatch, group functions, database/config, and the existing per-socket event model were preserved.

### Fixed

1. Pairing WebSocket detection (`ws.isOpen` + `readyState` fallback).
2. 20-second bounded pairing-open wait.
3. Temporary pairing credentials no longer count as a completed login; only `creds.registered === true` does.
4. Stale socket close events can no longer corrupt replacement-session runtime state.
5. Secondary pairing sockets do not auto-reconnect.
6. Main and secondary pairing locks are released correctly and duplicate secondary pairing requests are blocked.
7. Anti-demote/anti-promote/anti-kick punish the unauthorized executor by demotion instead of kicking the target.
8. Security-handled messages no longer continue into the command dispatcher.
9. Auto-typing and auto-recording are mutually exclusive.
10. Menu thumbnail work is lazy so unrelated commands do not depend on the menu image.
11. Safer message parsing and project-root temporary-file paths.
12. Added `npm test`, `npm run audit`, a static stability audit, and a security regression test.

## Verification

- 98 JavaScript files: syntax check PASS.
- 148 command case labels: unique.
- JSON manifests/config: valid.
- External imports: declared in package manifests.
- Pairing lifecycle invariants: PASS.
- Process crash guards: PASS.
- Security executor-punishment regression: PASS.

## Environment limitation

The complete dependency-backed test runner could not be executed here because the dependency installation was interrupted and `axios` remained unavailable. This is an environment limitation, not a source syntax failure. After installing dependencies on the bot host, run:

```bash
npm install
npm run audit
npm test
npm start
```
