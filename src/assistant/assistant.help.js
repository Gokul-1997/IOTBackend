/*
 * How to use MEXA — what the assistant answers "how do I…" from (22 Oct
 * 2026: "not only reports — all company support"). Written from the app as
 * it is (the menus in FrontendIOT src/app/layout/nav-menu.ts, the pages
 * behind them); change it with them. Static text: no database, nothing of
 * any company. The model gets only the sections that match the question.
 */
const SECTIONS = [
  {
    id: 'navigation', title: 'Where things are in MEXA',
    keywords: 'menu navigate find page where open screen dashboard analytics master admin profile settings sign out logout',
    text: `Menus along the top (each person sees only what their role allows):
- Dashboards: Live Dashboard (every machine right now), Factory Overall, Maintenance, Preventive, Periodic, Alarms, Downtime, Operators, OEE, Energy.
- Analytics: Reports, Charts, Quality, Maintenance Report.
- Alarms (active alarms to deal with), Downtime (record why a machine stopped), Maintenance (tickets, schedules, logs).
- Master: Machines, Program Transfer, Component, Job, Lines, Shifts, Operators, Tariff & Rates.
- Admin (company admin only): Users, Roles & Permissions.
The bell (top right) holds notifications; your name opens Profile, Settings and Sign out.`
  },
  {
    id: 'live', title: 'Live Dashboard and Factory Overall',
    keywords: 'live running idle offline breakdown status now current machine state real time factory overall timeline spindle detail',
    text: `- Dashboards → Live Dashboard shows every machine right now: running, idle, in alarm (breakdown) or offline (no data for over a minute). Open a machine for its detail, timeline and spindle data.
- Dashboards → Factory Overall shows the whole factory for a day or a shift: production, OEE, downtime, alarms and energy, with each figure linked to the page behind it.`
  },
  {
    id: 'reports', title: 'Reports and downloads',
    keywords: 'report reports production oee hourly shift records machine oee excel csv download export email columns filter period',
    text: `- Analytics → Reports has tabs: Production, OEE Hourly, Shift OEE, OEE Records and Machine OEE.
- Choose the dates, machines and shift (and the columns); the table shows exactly that.
- Excel and CSV download exactly what the screen shows. A download over 20,000 rows or longer than 92 days is prepared in the background and emailed to your own account email — check your email in about 10–15 minutes.`
  },
  {
    id: 'oee', title: 'How OEE is worked out',
    keywords: 'oee availability performance quality cycle time why zero empty missing calculation formula job component',
    text: `- OEE = availability × performance × quality.
- Availability: run time against planned time. Performance: parts made against what the cycle time allows. Quality: good parts against all parts made.
- Performance needs a cycle time: set the part's cycle time (Master → Component / Job) and the machine's current job. Without it OEE cannot be worked out and shows as not available.
- Quality uses the rejected parts entered on Analytics → Quality.`
  },
  {
    id: 'quality', title: 'Entering rejected and rework parts',
    keywords: 'quality reject rejected rework scrap defect enter parts bad good',
    text: `- Analytics → Quality: choose the machine, shift and date, then enter the rejected and rework parts.
- Rejected parts lower the quality part of OEE for that machine and shift.`
  },
  {
    id: 'alarms', title: 'Alarms and alarm notifications',
    keywords: 'alarm alarms critical notification notify alert inbox resolve severity settings',
    text: `- Alarms (top menu) lists active alarms to deal with; Dashboards → Alarms shows counts, top machines and trends for a period.
- Settings → Alarm notifications: "Receive alarm notifications" puts critical alarm alerts in your web and mobile inbox. A company admin can also have critical alarms notified immediately for the whole company.`
  },
  {
    id: 'downtime', title: 'Downtime and its reasons',
    keywords: 'downtime down stopped stop reason reasons idle unaccounted loss availability record',
    text: `- Downtime (top menu): record why a machine stopped — the reason, and when it started and ended.
- Dashboards → Downtime shows losses by reason, availability, and idle time that nobody gave a reason for ("unaccounted"). The more reasons are recorded, the less is unaccounted.`
  },
  {
    id: 'maintenance', title: 'Maintenance: tickets, schedules and reports',
    keywords: 'maintenance ticket tickets repair breakdown schedule schedules preventive periodic log logs technician assign mttr pm service',
    text: `- Maintenance (top menu): raise and assign tickets and follow them through to resolved, plan maintenance schedules, and log the work done.
- Dashboards → Maintenance shows machine condition; Preventive plans service by usage; Periodic by calendar.
- Analytics → Maintenance Report: repairs, tickets and repair time, to download.`
  },
  {
    id: 'program_transfer', title: 'Program Transfer: sending NC programs to machines',
    keywords: 'program programs transfer upload nc file cnc send machine backup gateway token waiting line queue refused download',
    text: `- Master → Program Transfer: choose the machine, then Upload program (.nc and other NC text files up to 20 MB). Uploading needs the "Upload to library" and "Send to machine" permissions.
- Programs wait in line for each machine, oldest first; the company's gateway sends them one at a time. A file shows "Next to send", "Waiting · 2nd in line", "On the machine" or "Refused by machine" with the reason.
- Backup now asks the gateway to send the machine's current program back; it appears under Backups.
- The page shows whether the company's gateway is online. Its token is made by S&T, not on this page.`
  },
  {
    id: 'energy', title: 'Energy and costs',
    keywords: 'energy power kwh electricity cost tariff rate rupees bill overload peak per part',
    text: `- Dashboards → Energy: kWh used, cost, kWh per part, and machines over their overload limit.
- Costs need the tariff: Master → Tariff & Rates holds the electricity rate (₹ per kWh) and each machine's ₹ per hour.
- Energy is known only for machines whose device sends an energy counter.`
  },
  {
    id: 'master_data', title: 'Machines, shifts, operators and jobs',
    keywords: 'machine machines add new edit shift shifts break breaks operator operators line lines component job plant setup master hour rate',
    text: `- Master → Machines: add and edit machines and their details (the number allowed comes from the company's plan).
- Master → Shifts: shift times and breaks. Master → Operators: operators. Master → Lines: lines.
- Master → Component and Job: parts and their cycle times — OEE performance needs them.`
  },
  {
    id: 'users_roles', title: 'Users, roles, access and passwords',
    keywords: 'user users add role roles permission permissions access cannot see missing menu button password forgot reset login sign in admin',
    text: `- The company admin manages people: Admin → Users (add people, their role and plant) and Roles & Permissions (what each role can see and do).
- Which pages the company can use at all is set by S&T for the company; if a menu or button is missing for everyone, ask S&T.
- Your password: Profile → Change password. Forgot it: "Forgot password" on the sign-in page.`
  },
  {
    id: 'notifications', title: 'Notifications',
    keywords: 'notification notifications bell unread message alert open',
    text: `- The bell (top right) shows your notifications and how many are unread.
- Click a notification to open the exact record it is about (an alarm, a program, a report) — it is marked on that page.`
  },
  {
    id: 'assistant', title: 'About Mexa AI',
    keywords: 'assistant ai chatbot mexa allowance limit answers left reset switch off',
    text: `- Mexa AI answers from your company's own MEXA data and only what your role may see. It only reads: it cannot change anything in MEXA.
- It answers questions about your company in MEXA and about using MEXA — nothing else (no general questions).
- How much it may be used is set by S&T for the whole company: answers a day for each person (shown under the question box as "left today"), questions a day for the company, and a monthly limit. It resets at midnight, company time. To have more, ask S&T.
- Answers can be wrong: check important figures on the report itself (View report under an answer).`
  },
  {
    id: 'support', title: 'Getting more help',
    keywords: 'help support contact problem issue error bug not working broken who',
    text: `- Access, roles, users and passwords: your company admin.
- The company's pages, plan limits (machines, users, plants), how much Mexa AI may be used, and the Program Transfer gateway token: S&T.
- When something shows an error, note the reference ("ref") in the message — it helps support find what happened.`
  }
];

const words = s => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];

/** The sections that answer a question best (at most three), or the list of topics. */
function helpFor(topic) {
  const asked = new Set(words(topic).filter(w => w.length > 2));
  const scored = SECTIONS.map(s => {
    const keys = new Set([...words(s.keywords), ...words(s.title)]);
    let score = 0;
    for (const w of asked) if (keys.has(w) || [...keys].some(k => k.length > 3 && (k.startsWith(w) || w.startsWith(k)))) score += 1;
    return { s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  if (!scored.length) return { topics: SECTIONS.map(s => s.title) };
  return { sections: scored.map(({ s }) => ({ title: s.title, text: s.text })) };
}

module.exports = { helpFor, SECTIONS };
