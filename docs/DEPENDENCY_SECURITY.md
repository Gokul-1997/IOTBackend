# Dependency security verification — 13 October 2026

The dependency checks queried public npm advisory metadata. Application databases, Redis, SMTP, MQTT, cloud storage and CNC devices were not accessed.

## Final executed npm audits

| Dependency tree | Result |
| --- | --- |
| Backend runtime (`npm audit --omit=dev`) | 0 advisories |
| Backend including test tooling (`npm audit`) | 0 advisories |
| Mobile SDK tree (`npm audit --omit=dev`) | 15 high, 0 moderate, 0 critical |

The original backend runtime audit reported 2 high entries. The original mobile audit reported 32 entries, including 1 critical. Counts describe affected packages and dependency chains, rather than independent vulnerabilities. Audit results can change as upstream advisories are published.

## Changes and compatibility

- Nodemailer is now 10.1.0. Its existing `createTransport`/`sendMail` API remains supported. Backend Node.js must be 20 or newer. A real stream transport generated an email and attachment entirely in memory during verification. [Official Nodemailer documentation](https://nodemailer.com/).
- The unsupported npm `xlsx` package was replaced with ExcelJS 4.4.0. Report exports await buffer generation. Real XLSX files were reopened and checked for report headers, numeric zero, decimals, dates, booleans, Unicode and literal text beginning with formula characters. [ExcelJS source and documentation](https://github.com/exceljs/exceljs).
- ExcelJS receives a scoped `uuid` 11.1.1 override. Its CommonJS `v4` API is compatible with the inspected caller.
- Backend test tooling uses Jest 30.5.2. The Istanbul YAML-config loader receives a scoped `js-yaml` 4.3.2 override: its caller uses the supported `load()` API. Real YAML configuration parsing and full coverage instrumentation passed. [Jest 30 upgrade guide](https://jestjs.io/docs/upgrading-to-jest30).
- Mobile retains Expo SDK 57, React Native 0.86.3 and React 19.2.3. Expo was patched to 57.0.28; notifications and splash-screen use its recommended compatible patches. Axios is 1.20.0. Compatible transitive patches address shell-quote, source-map-js, brace-expansion and xmldom. Navigation core 7.23.0 removes the old query-string dependency chain. [Versioned Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/).
- Mobile Xcode tooling receives a scoped `uuid` 11.1.1 override. Its inspected caller uses CommonJS `v4`; generating 100 valid unique project identifiers passed. Mobile Node.js must be 22.13 or newer, consistent with SDK 57.

The overrides are limited to the inspected callers. Reassess and remove each override when its upstream package adopts a patched dependency itself.

## Remaining mobile findings

All 15 remaining high package entries propagate these two upstream advisories:

| Package currently installed | Advisory | Dependency use |
| --- | --- | --- |
| `braces` 3.0.3 | [Stack-exhaustion denial of service](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Micromatch and Metro source-file matching |
| `node-forge` 1.4.0 | [RSA signature-verification issue](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | Expo CLI and code-signing certificate tooling |

Neither package had a patched stable npm release at the time of verification. Expo and Metro are published within the mobile SDK's production dependency graph, so `--omit=dev` still reports their tooling chains. The mobile dependency audit remains nonzero until suitable upstream fixes are available. Recheck these advisories before the next mobile release. npm's suggested Expo 44 or React Native 0.72 downgrade is incompatible with this SDK and was not applied.

## Executed verification

- Backend: 85 suites and 1,696 tests passed with Jest 30 and real coverage instrumentation. Database, Redis and email tests use isolated fixtures; HTTP integration tests use temporary local listeners.
- Mobile TypeScript check passed.
- Mobile realtime tests: 11 passed. Request-lifecycle tests: 6 passed.
- Expo's bundled dependency compatibility checker reported all dependencies up to date (`EXPO_OFFLINE=1 ... expo install --check`).
- These checks do not substitute for an Android/iOS native release build or physical device validation.

Reproduce the advisory queries from each repository:

```sh
# Backend
npm audit --json
npm audit --omit=dev --json

# MobileApp
npm audit --omit=dev --json
```
