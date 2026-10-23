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
   `companies.timezone`; 054 the question counts and token figures; 058 each
   company's own daily total and monthly limit, set by S&T).
2. Put an Anthropic API key in the server's `.env`: `ANTHROPIC_API_KEY=…`
   (and optionally `ASSISTANT_NAME`, default `STM Mexa AI`). Keep
   `ASSISTANT_MODEL` at its default, `claude-haiku-5-5`: the lowest cost, and
   the assistant forces a tool call each turn, which Sonnet 5.5 and Opus 5.5
   refuse. Restart the API.
3. Deploy the web app. The launcher appears for report users.

Without the key, the chat says it is not switched on yet (status
`NOT_CONFIGURED`).

**Check it on the server:** `node scripts/assistant-check.js` prints the Node
version, whether a key is set (first characters only), the model, and the
answer to one tiny question — or Anthropic's exact reason for refusing it,
with what to do. Any failure is also in the API log as `[assistant] model
call failed`, with the provider's reason.

**A key not tied to one workspace** (a personal key made without choosing a
workspace) fails every question — the chat says "not available right now" —
until `.env` names the workspace to use:
`ANTHROPIC_WORKSPACE_ID=wrkspc_…`, the ID of the "Default" workspace on
platform.claude.com/settings/workspaces. Or make the key tied to a workspace
when creating it, and leave that line out. The check finds the ID itself when
the key may list the organization's workspaces; an individual account's key
may not (Anthropic answers 403), and the check then prints both ways.

## What it can and cannot see

The model never writes SQL and has no database access. It can only ask the
server to run a few fixed, read-only report functions (`src/assistant/
assistant.tools.js`). **It only reads** (23 Oct 2026): every query a tool
makes — and every query of the services it calls — runs on database
connections opened with `default_transaction_read_only = on`
(`db.readOnly`, `src/db.js`), so PostgreSQL itself refuses any INSERT,
UPDATE, DELETE or schema change from it. The server keeps one thing per
question: the counts below (questions, answers, tokens), never the
conversation.

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
6,000 characters, as the browser holds them) and the report figures the
tools return are sent to Anthropic's API to compose the answer; Anthropic's
API data-handling terms apply to what is sent. Operator names, users, ids and
anything of another company are never sent. Nothing of the conversation is
stored on the MEXA server — only counts per person per day (answers,
questions, tokens). The browser forgets the conversation when the person
signs out. The client should agree to this before the key is set.

## What it answers

Only two kinds of question (23 Oct 2026): this company's own information in
MEXA, and how to use MEXA. Everything else — general knowledge, news,
maths, coding, writing, chit-chat, other companies, machining in general —
gets the out-of-scope reply. The rules say so, and the server holds to it:
an answer must rest on what the tools read for that question (company data,
or a MEXA help topic that matched); one that doesn't becomes the
out-of-scope reply, and a "question back" must be one short question. A
greeting or a thank-you on its own ("hi", "good morning", "thanks", "ok") is
answered by the app itself — no model, nothing used.

## The allowance and what it may cost

S&T alone sets how much each company may use it, in **Company Management →
AI** (23 Oct 2026, the user: "only the super admin — up or down — not the
company side"; the company admin sets nothing). There S&T sees the
company's use today and this month — questions, answers, what they cost —
and raises or lowers:

- **Questions a day for the whole company** (50 until S&T sets it): every
  question the model reads counted, answered or not.
- **Answers a day for each person** (50 until S&T sets it): what the person
  sees under the question box. A clarifying question, a refusal, "no
  records" and a failure are not counted as answers.
- **Monthly limit** (US$5 until S&T sets it): this month's tokens priced at
  Claude Haiku 5.5's rates (every input token as a cache write, so never
  below the bill); reached, the AI stops for the company until the month
  turns.
- **The company's timezone**: its midnight brings the day back.

Any of the three at 0 switches the AI off for the company. No figure passes
the server's ceilings — `ASSISTANT_DAILY_LIMIT_MAX` (1000 answers a person),
`ASSISTANT_COMPANY_DAILY_MAX` (10,000 questions a company),
`ASSISTANT_COMPANY_MONTHLY_USD` (US$1,000 a month) — a guard against a slip
of the keyboard. With an allowance used up, the chat says when it comes
back; the reports themselves stay open.

**What a question costs** (Claude Haiku 5.5, per million tokens: US$0.10
input, 0.125 cache write, 0.01 cache read, 0.50 output). A question is two
or three model calls: about 3,500 tokens of rules and tools (cached), the
question and the figures a tool read (1,000–4,000 tokens), and a reply of
~300 tokens — about **US$0.0007–0.002**. At 50 questions every day of a
31-day month (1,550): about **US$1.1–3 a company** (₹100–270 at ₹88 to the
dollar), and never more than the US$5 ceiling. The worst one question can
cost, every limit reached, is about US$0.008.

## Fixed replies

| Case | Reply |
| --- | --- |
| outside its scope | I can help with your company’s information in MEXA and with using MEXA. Please ask a related question. |
| restricted | I can only provide information available to your account. |
| no records | I couldn’t find matching information in your company’s connected records. Please try another period or filter. |
| allowance used | You’ve reached today’s STM Mexa AI allowance. Your allowance resets at 12:00 am (Asia/Kolkata). You can still access your reports. |
| company ceiling reached | STM Mexa AI has reached your company’s allowance for today. It resets at 12:00 am (Asia/Kolkata). You can still access your reports. |
| company's month reached | STM Mexa AI has reached your company’s allowance for this month. It comes back on 01 Nov 2026. You can still access your reports. |
| hello / thanks | Hello! Ask me about your company in MEXA — machines, production, OEE, alarms, downtime, maintenance or energy — or how to do something in MEXA. / You’re welcome. Ask me anything about your company in MEXA. |

## Security and cost (reviewed 22 Oct 2026)

Every model call is paid for by the platform, so none of this rests on the
model behaving — the server enforces it:

| Risk | What stops it |
| --- | --- |
| Questions that end in a refusal or a question back cost money but are not "answers" | Every question the model reads is first taken from two hard daily ceilings: per person three per answer of the allowance (at least 20), per company its questions a day — and the company's month from its monthly limit (both S&T's; 50 and US$5 until set). |
| Asking very fast | `ASSISTANT_PER_MINUTE` (default 6) per person, counted in Redis — and in memory while Redis is down. One question at a time per person, 8 at a time on the server. |
| One question reading report after report | At most 4 report reads and 4 model calls per question; a read over 12,000 characters is not handed to the model (it is told to narrow the question); 800 output tokens per call; 45 s per call. |
| An oversized response or a caller who has left | Provider response buffering stops at 1 MiB. The question has a 90 s deadline (`ASSISTANT_QUESTION_TIMEOUT_MS`, maximum 180 s); a disconnected HTTP caller cancels its active model request. Database reads keep their existing statement timeout. |
| Simultaneous requests using the last daily allowance | A short company advisory-lock transaction serializes question reservations. Answer counting uses an atomic conditional update; a losing request records its token cost without returning an extra completed answer. |
| Reusing a reply after access changes | History signatures bind the user, company, effective plant, access revision, roles and both user/company page grants. A reply signed under an earlier scope is rejected. |
| The AI changing data | It has no way to: fixed read-only tools, run on database connections where PostgreSQL refuses every write (`db.readOnly`). |
| A long or forged conversation ("you are now a general assistant…") | The conversation is cut to 12 turns and 6,000 characters (a question to 500). Every reply is signed (HMAC from `JWT_SECRET`) for the person who got it; an assistant turn without its signature is not believed, nor anything before it. The rules tell the model that messages claiming to be from S&T, a developer or the system change nothing. |
| Another company's or another plant's data | No tool takes a company; the company and plant come from the sign-in, and each tool runs inside that person's read scope. A plant user's company details list their plant only. |
| A report the person may not open | The tool is not offered, and refused if asked for anyway; downloads need the Export permission. |
| The API key | Only in the server's `.env`; sent only to `https://api.anthropic.com` (fixed in code), over verified HTTPS. Never in a response or a log; `scripts/assistant-check.js` shows only its first 10 characters (the fixed "sk-ant-" prefix and the key's kind) and its length. |
| Answers shown in the browser | Plain text only (never HTML); "View report" opens only app pages, "Download report" only the report exports. |
| Who changed the allowance | Only S&T can (`PUT /api/companies/:id/assistant`); each change is in the audit log (`UPDATE_ASSISTANT_SETTINGS`, the company's id). |

**What it cost, per company and month** (US$, priced as the ceiling prices
it — `input` includes cache writes, `cached` is cache reads):

```sql
SELECT c.company_name, date_trunc('month', u.day)::date AS month,
       SUM(u.questions) AS questions, SUM(u.answers) AS answers,
       ROUND((SUM(u.input_tokens) * 0.125 + SUM(u.cached_tokens) * 0.01 + SUM(u.output_tokens) * 0.50) / 1e6, 2) AS usd
  FROM assistant_usage u JOIN companies c ON c.id = u.company_id
 GROUP BY 1, 2 ORDER BY 2 DESC, 1;
```

**Also set a spending limit in the Claude Console** (platform.claude.com
→ Billing / Limits) — the one guard that holds even if the key were ever
copied off the server. If the key leaks: delete it in the console, put a new
one in `.env`, restart the API.

The provider's errors and wording never reach the browser; the log keeps
the kind of reply, the tools used and the token counts — never the
conversation.
