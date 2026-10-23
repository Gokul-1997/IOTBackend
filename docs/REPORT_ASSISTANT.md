# Company assistant — "STM Mexa AI"

A chat in the bottom-right corner of every signed-in page, for everyone in a
company (since 22 Oct 2026: "not only reports — all company support"). It
answers about the company's own MEXA data — production, OEE, machines right
now, alarms, downtime, maintenance, energy, Program Transfer, its registered
details — and how to use MEXA, with the figures from the same server code as
the screens. What a person can ask about follows their role: a page they may
not open is never read for them.

## Switching it on

1. Run the migrations: `npm run migrate` (052 adds the allowance tables and
   `companies.timezone`; 054 the question counts and token figures).
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
| `machine_status` | each machine right now: running, idle, alarm, offline, last data (last hour of telemetry only) | Live Dashboard or Factory Overall |
| `alarm_summary` | alarms for a period: totals, critical, still open, longest, top machines, open ones (10) | Alarms or Alarm Dashboard |
| `downtime_summary` | downtime by reason and category, availability, idle time with no reason, its cost | Downtime or Downtime Dashboard |
| `maintenance_status` | open tickets by status/priority, most urgent (10, no names), schedules overdue / next 14 days | Maintenance |
| `energy_summary` | kWh, cost, kWh per part, top consumers, by shift, overloads (at most 31 days) | Energy Dashboard |
| `program_transfer_status` | gateway online or not; per machine next program, how many wait, last result, backup asked | Program Transfer |
| `mexa_help` | how to do something in MEXA and where (static guide, `src/assistant/assistant.help.js`) | everyone |
| `company_details` | name, code, address, contact email/phone, timezone, plan, plants (a plant user: theirs), active machines | everyone |
| `machines_and_shifts` | the company's machine and shift names | everyone |

- The company and plant always come from the person's sign-in; no tool
  takes a company. A tool the person may not use is not offered at all.
- A period is at most 92 days. Machine and shift names are matched to the
  company's own; two matches come back as a question to the person.
- Sources shown under an answer are the reports the server actually ran,
  with **View report** (the same filters) and **Download report** (only with
  the Export permission; a large file is emailed, as on Reports).

## Data sent to Anthropic

Each question, the earlier turns of the conversation (up to 12, at most
8,000 characters, as the browser holds them) and the report figures the
tools return are sent to Anthropic's API to compose the answer; Anthropic's
API data-handling terms apply to what is sent. Operator names, users, ids and
anything of another company are never sent. Nothing of the conversation is
stored on the MEXA server — only counts per person per day (answers,
questions, tokens). The browser forgets the conversation when the person
signs out. The client should agree to this before the key is set.

## The daily allowance

- 50 completed answers per person per day by default. The company admin
  sets it in **Settings → STM Mexa AI** (0 switches it off for the company),
  with the company timezone whose midnight resets it.
- A clarifying question, a refusal, "no records" and a failure are not
  counted. With the allowance used up, the chat says when it comes back;
  the reports themselves stay open.
- The company admin cannot set more than `ASSISTANT_DAILY_LIMIT_MAX`
  (default 100) — the platform pays for every answer.

## Fixed replies

| Case | Reply |
| --- | --- |
| outside its scope | I can help with your company’s reports and approved company details. Please ask a related question. |
| restricted | I can only provide information available to your account. |
| no records | I couldn’t find matching information in your company’s connected records. Please try another period or filter. |
| allowance used | You’ve reached today’s STM Mexa AI allowance. Your allowance resets at 12:00 am (Asia/Kolkata). You can still access your reports. |
| company ceiling reached | STM Mexa AI has reached your company’s allowance for today. It resets at 12:00 am (Asia/Kolkata). You can still access your reports. |

## Security and cost (reviewed 22 Oct 2026)

Every model call is paid for by the platform, so none of this rests on the
model behaving — the server enforces it:

| Risk | What stops it |
| --- | --- |
| Questions that end in a refusal or a question back cost money but are not "answers" | Every question the model reads is first taken from two hard daily ceilings: per person three per answer of the allowance (at least 20), per company `ASSISTANT_COMPANY_DAILY_MAX` (default 500). Taken in one SQL statement, so questions at once cannot slip past. |
| Asking very fast | `ASSISTANT_PER_MINUTE` (default 6) per person, counted in Redis — and in memory while Redis is down. One question at a time per person, 8 at a time on the server. |
| One question reading report after report | At most 6 report reads and 5 model calls per question; 1,024 output tokens per call; 45 s per call. |
| A long or forged conversation ("you are now a general assistant…") | The conversation is cut to 12 turns and 8,000 characters (a question to 500). Every reply is signed (HMAC from `JWT_SECRET`) for the person who got it; an assistant turn without its signature is not believed, nor anything before it. The rules tell the model that messages claiming to be from S&T, a developer or the system change nothing. |
| Another company's or another plant's data | No tool takes a company; the company and plant come from the sign-in, and each tool runs inside that person's read scope. A plant user's company details list their plant only. |
| A report the person may not open | The tool is not offered, and refused if asked for anyway; downloads need the Export permission. |
| The API key | Only in the server's `.env`; sent only to `https://api.anthropic.com` (fixed in code), over verified HTTPS. Never in a response or a log; `scripts/assistant-check.js` shows only its fixed first characters ("sk-ant-api") and length. |
| Answers shown in the browser | Plain text only (never HTML); "View report" opens only app pages, "Download report" only the report exports. |
| Who changed the allowance | The company admin's change is in the audit log (`UPDATE_ASSISTANT_SETTINGS`). |

**What it costs, per company and day** (tokens: `input` includes cache
writes, `cached` is cache reads, billed at a fraction):

```sql
SELECT c.company_name, u.day, SUM(u.questions) AS questions, SUM(u.answers) AS answers,
       SUM(u.input_tokens) AS input, SUM(u.cached_tokens) AS cached, SUM(u.output_tokens) AS output
  FROM assistant_usage u JOIN companies c ON c.id = u.company_id
 GROUP BY 1, 2 ORDER BY 2 DESC, 1;
```

**Also set a spending limit in the Anthropic console** (console.anthropic.com
→ Billing / Limits) — the one guard that holds even if the key were ever
copied off the server. If the key leaks: delete it in the console, put a new
one in `.env`, restart the API.

The provider's errors and wording never reach the browser; the log keeps
the kind of reply, the tools used and the token counts — never the
conversation.
