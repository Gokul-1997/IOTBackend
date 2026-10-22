/*
 * The assistant's fixed sentences — the product spec's own wording
 * (22 Oct 2026), with the assistant's name (ASSISTANT_NAME, "STM Mexa AI")
 * put in. The app shows these itself rather than letting the model phrase
 * them, so a refusal or a limit reads the same every time.
 */
module.exports = name => ({
  welcome: `Hi, I’m ${name}, your company’s report assistant. I can help you understand your reports, compare results, and find company details available to your account. What would you like to know?`,
  outOfScope: 'I can help with your company’s reports and approved company details. Please ask a related question.',
  restricted: 'I can only provide information available to your account.',
  notFound: 'I couldn’t find matching information in your company’s connected records. Please try another period or filter.',
  limit: resetsAt => `You’ve reached today’s ${name} allowance. Your allowance resets at ${resetsAt}. You can still access your reports.`,
  companyLimit: resetsAt => `${name} has reached your company’s allowance for today. It resets at ${resetsAt}. You can still access your reports.`,
  switchedOff: `${name} is switched off for your company.`,
  unavailable: `${name} is not available right now. Please try again in a few minutes.`,
  busy: `${name} is busy right now. Please try again in a moment.`,
  stillAnswering: `${name} is still answering your last question.`,
  unfinished: `${name} could not finish this answer. Please ask again with a period, machine or shift.`
});
