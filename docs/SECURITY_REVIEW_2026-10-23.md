# Security and resource-use review — 23 October 2026

This review covers the backend, Angular dashboard and Electron shell. Changes are local and have not been deployed. Program Transfer source and workflow were left unchanged, as requested. The mobile application was not part of this pass.

## Fixed

- Account changes in another browser tab immediately retire the previous session's requests, sockets and cached data before reload completes. The new shared credentials are preserved.
- AI history signatures now bind replies to the current company, effective plant, access revision, roles and user/company permissions. Replies from an earlier access scope cannot be reused as trusted history.
- AI question reservations serialize the company-wide daily ceiling across server processes. Atomic answer counting prevents simultaneous completions from returning an extra answer beyond the person's allowance.
- AI provider responses stop buffering at 1 MiB. A whole-question deadline and HTTP disconnect cancellation stop pending provider requests; timers and listeners are cleaned up. Existing database statement timeouts remain in force.
- Established live sockets disconnect when their access token expires, using the existing refresh/reconnect flow.
- Shared input validation rejects arrays/objects where strings are required, unsafe numeric coercion, non-finite numbers and non-object request bodies.
- User, role, alarm, shift, dashboard and profile/reset-password controller failures now pass unexpected errors through the shared redaction boundary. Public validation messages are preserved; internal errors return a generic message and support reference. Unexpected 503 messages are also redacted.
- Electron confines custom-protocol requests to the bundled website, rejects encoded path escapes and foreign hosts, blocks navigation outside the app origin, denies popup windows, and opens only HTTP(S) external links. Renderer sandboxing and custom-protocol CORS enforcement are explicit.
- Updated compatible frontend tooling and the vulnerable `ip-address` dependency. Electron is 43.8.3 and electron-builder is 26.15.3. A scoped Tailwind selector-parser override removes the parser advisory without changing the generated stylesheet.

## Verification

| Check | Result |
| --- | --- |
| Backend regression suite, isolated database/Redis fixtures | 113 suites, 2,230 tests passed |
| Angular regression suite | 44 files, 327 tests passed |
| Desktop URL/path security tests | 4 tests passed |
| Angular production build | Passed; stylesheet byte-for-byte identical after the parser security override |
| Electron development startup | Login rendered; no page errors; encoded local-file escapes and foreign app hosts returned 404 |
| Unsigned macOS arm64 packaging | Passed |
| Packaged desktop startup, isolated profile | Login rendered |
| Backend npm advisory audit, all dependencies | 0 advisories |
| Frontend npm advisory audit, production dependencies | 0 advisories |
| Frontend npm advisory audit, all dependencies | 5 high package entries; 0 moderate or critical |

The remaining five entries all propagate the [braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) through Tailwind 3's source-file matching dependencies (`braces`, `chokidar`, `micromatch`, `fast-glob`, `tailwindcss`). npm still publishes braces 3.0.3 as its stable version at this review date. These are build-time dependencies, absent from the browser's production dependency tree. The suggested Tailwind 4 migration changes the styling pipeline and requires a separate visual regression pass. The audit remains nonzero until that chain is replaced or a suitable upstream fix is available.

Production build warnings remain: the initial bundle is 547.91 kB against a 500 kB warning threshold (127.80 kB estimated transfer); assistant and maintenance-dashboard styles exceed their 4 kB warning thresholds and remain below the 8 kB error limit. Budgets were not raised to hide these warnings.

Local automated checks do not establish live production throughput, memory behavior under sustained customer load, or Windows/macOS release acceptance. No live application database, customer account, CNC machine or production deployment was used. Desktop packages were unsigned; signed releases and deployment remain separate work.

Before deploying desktop builds, include the exact `app://localhost` origin in the API server's `CORS_ORIGINS`, alongside the web origin. The upgraded desktop scheme enforces CORS; startup smoke checks used an isolated profile and did not exercise a live sign-in.

## Reproduce

Backend:

```sh
npm test -- --runInBand
npm audit --json
```

Frontend:

```sh
npm run test:ci
npm run test:desktop
npm run build
npm audit --omit=dev --json
npm audit --json
```

Electron's official [breaking-changes reference](https://www.electronjs.org/docs/latest/breaking-changes) was checked for the runtime upgrade. Reassess the scoped selector-parser override when Tailwind adopts a patched parser itself.
