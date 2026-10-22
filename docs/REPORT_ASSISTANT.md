# Report assistant — "STM Mexa AI"

A chat in the bottom-right corner of every signed-in page, for people who
can open Reports or OEE Records. It answers questions about the company's
own reports — production, OEE, machines, shifts — and its registered
details, with the figures from the same server code as the screens.

## Switching it on

1. Run the migrations: `npm run migrate` (052 adds the allowance tables and
   `companies.timezone`).
2. Put an Anthropic API key in the server's `.env`: `ANTHROPIC_API_KEY=…`
   (and optionally `ASSISTANT_MODEL`, default `claude-haiku-5-5` — the lowest
   cost; `claude-sonnet-5-5` / `claude-opus-5-5` cost more;
   `ASSISTANT_NAME`, default `STM Mexa AI`). Restart the API.
3. Deploy the web app. The launcher appears for report users.

Without the key, the chat says it is not switched on yet (status
`NOT_CONFIGURED`).

**Check it on the server:** `node scripts/assistant-check.js` prints the Node
version, whether a key is set (first characters only), the model, and the
answer to one tiny question — or Anthropic's exact reason for refusing it,
with what to do. A key not scoped to a workspace needs
`ANTHROPIC_WORKSPACE_ID=wrkspc_…` as well (or make the key inside a
workspace). Any failure is also in the API log as `[assistant] model call
failed`, with the provider's reason.

## What it can and cannot see

The model never writes SQL and has no database access. It can only ask the
server to run a few fixed, read-only report functions (`src/assistant/
assistant.tools.js`):

| Tool | What it returns | Needs |
| --- | --- | --- |
| `production_report` | parts, run/idle hours, energy, efficiency; by machine, shift, day | Reports |
| `oee_report` | overall and per-machine OEE, availability, performance, quality (the OEE Dashboard's figures) | Reports, OEE Records or OEE Dashboard |
| `company_details` | name, code, address, contact email/phone, timezone, plan, plants, active machines | report access |
| `machines_and_shifts` | the company's machine and shift names | report access |

- The company and plant always come from the person's sign-in; no tool
  takes a company. A tool the person may not use is not offered at all.
- A period is at most 92 days. Machine and shift names are matched to the
  company's own; two matches come back as a question to the person.
- Sources shown under an answer are the reports the server actually ran,
  with **View report** (the same filters) and **Download report** (only with
  the Export permission; a large file is emailed, as on Reports).

## Data sent to Anthropic

Each question, the earlier turns of the conversation (up to 12, as the
browser holds them) and the report figures the tools return are sent to
Anthropic's API to compose the answer; Anthropic's API data-handling terms
apply to what is sent. Nothing is stored on the MEXA server except a count of
answers per person per day. The browser forgets the conversation when the
person signs out. The client should agree to this before the key is set.

## The daily allowance

- 50 completed answers per person per day by default. The company admin
  sets it in **Settings → STM Mexa AI** (0 switches it off for the company),
  with the company timezone whose midnight resets it.
- A clarifying question, a refusal, "no records" and a failure are not
  counted. With the allowance used up, the chat says when it comes back;
  the reports themselves stay open.

## Fixed replies

| Case | Reply |
| --- | --- |
| outside its scope | I can help with your company’s reports and approved company details. Please ask a related question. |
| restricted | I can only provide information available to your account. |
| no records | I couldn’t find matching information in your company’s connected records. Please try another period or filter. |
| allowance used | You’ve reached today’s STM Mexa AI allowance. Your allowance resets at 12:00 am (Asia/Kolkata). You can still access your reports. |

## Limits on the server

One question at a time per person, 8 at a time across the server
(`ASSISTANT_MAX_CONCURRENT`), at most 5 model rounds per question, 45 s per
model call. The provider's errors and wording never reach the browser; the
log keeps sizes and token counts, never the conversation.
