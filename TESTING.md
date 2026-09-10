# Backend Testing

## Layers

| Layer | Where | When |
|---|---|---|
| **Unit** | `__tests__/lib/`, `__tests__/utils/` | Pure functions only — no DB, no IO |
| **Service** | `__tests__/services/` | Business logic with `mockDb` (no real Postgres) |
| **Integration** | `__tests__/integration/` | Real Express + supertest, mocked DB |

## Run

```bash
npm test            # all suites
npm run test:watch  # iterate while writing
npm run test:cov    # coverage report → ./coverage/
```

## Adding a service test

```js
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/<your-module>/<your>.service');

beforeEach(() => resetDb());

test('does the thing', async () => {
  mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
  const out = await svc.doSomething(args);
  expect(out).toEqual(...);
  expect(mockDb.calls()[0].text).toMatch(/SELECT/);
});
```

## Adding an integration test

```js
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { buildApp, fakeUser } = require('../helpers/testApp');
const router = require('../../src/<module>/<module>.routes');

const app = buildApp({ mountPath: '/api/<x>', router, user: fakeUser() });
const res = await request(app).get('/api/<x>');
```

## Coverage targets

- Pure utilities: **100%**
- Services: **80%+**
- Routes: smoke test on each verb

## What NOT to test here

- Real DB queries → use a separate `e2e-pg` suite (Testcontainers) when needed
- Frontend behaviour → that's Playwright in `FrontendIOT/e2e/`
- MQTT broker behaviour → that's `pms-backend/__tests__/`

