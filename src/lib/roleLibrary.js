// Library of common roles broken into tasks, used by the career agent.
// Each task: hours/week and five attributes in [0,1]: repetitive, rules_based, data_heavy, judgment, empathy.
// A person's job title is matched to the closest role; with an LLM configured, unknown titles get
// a generated breakdown instead.
const T = (role, task, h, rep, rule, data, judg, emp, skill) => ({ role, task, hours_per_week: h, repetitive: rep, rules_based: rule, data_heavy: data, judgment: judg, empathy: emp, skill });

export const ROLE_TASKS = [
  T('Software Engineer', 'Write boilerplate/CRUD code', 8, .8, .7, .3, .3, 0, 'System design'),
  T('Software Engineer', 'Write unit tests', 5, .8, .8, .3, .2, 0, 'Test strategy'),
  T('Software Engineer', 'Debug production issues', 6, .3, .3, .6, .8, .1, 'Observability'),
  T('Software Engineer', 'Design new features with PM', 5, .1, .1, .3, .9, .4, 'Product thinking'),
  T('Software Engineer', 'Code reviews', 4, .5, .5, .3, .7, .3, 'Technical leadership'),
  T('Software Engineer', 'Write docs & PR descriptions', 3, .7, .6, .2, .2, .1, 'Technical writing'),
  T('Software Engineer', 'Standups & sprint rituals', 4, .6, .5, .1, .3, .6, 'Communication'),
  T('Engineering Manager', '1:1s and coaching', 8, .2, .1, .1, .8, 1, 'Coaching'),
  T('Engineering Manager', 'Hiring interviews', 5, .4, .4, .3, .9, .6, 'Talent assessment'),
  T('Engineering Manager', 'Status reports for leadership', 4, .9, .7, .7, .2, 0, 'Strategic narrative'),
  T('Engineering Manager', 'Sprint planning & estimation', 5, .5, .4, .6, .7, .3, 'Delivery management'),
  T('Engineering Manager', 'Architecture decisions', 6, .1, .2, .4, 1, .2, 'Architecture'),
  T('Engineering Manager', 'Performance reviews', 3, .3, .3, .5, .9, .9, 'Feedback'),
  T('Data Analyst', 'Write SQL for ad-hoc requests', 10, .8, .7, 1, .3, 0, 'Data modelling'),
  T('Data Analyst', 'Build & refresh dashboards', 8, .9, .8, 1, .2, 0, 'Metric design'),
  T('Data Analyst', 'Clean and validate data', 6, .9, .9, 1, .2, 0, 'Data quality engineering'),
  T('Data Analyst', 'Present insights to stakeholders', 4, .1, .1, .5, .8, .7, 'Storytelling'),
  T('Data Analyst', 'Define business metrics with teams', 4, .2, .2, .6, .9, .5, 'Business acumen'),
  T('Data Analyst', 'Root-cause analysis on metric drops', 5, .3, .3, .9, .9, .1, 'Causal inference'),
  T('Support Associate', 'Answer repetitive customer queries', 18, 1, .9, .3, .2, .5, 'Product expertise'),
  T('Support Associate', 'Update ticket notes & tags', 6, 1, 1, .4, .1, 0, 'Process design'),
  T('Support Associate', 'Handle escalated/angry customers', 8, .3, .2, .2, .7, 1, 'De-escalation'),
  T('Support Associate', 'Identify recurring product bugs', 3, .4, .3, .6, .7, .1, 'Product feedback loops'),
  T('Support Associate', 'KYC document checks', 5, .9, 1, .5, .3, 0, 'Risk & compliance'),
  T('HR Business Partner', 'Answer policy questions', 8, .9, .9, .2, .2, .4, 'Policy design'),
  T('HR Business Partner', 'Employee relations cases', 6, .1, .2, .2, 1, 1, 'Conflict resolution'),
  T('HR Business Partner', 'Attrition & headcount reports', 5, .8, .7, 1, .3, 0, 'People analytics'),
  T('HR Business Partner', 'Org design with leaders', 5, .1, .1, .5, 1, .6, 'Org design'),
  T('HR Business Partner', 'Onboarding coordination', 4, .8, .8, .3, .2, .5, 'Experience design'),
  T('HR Business Partner', 'Performance cycle calibration', 4, .3, .4, .6, .9, .7, 'Talent management'),
  T('Relationship Manager', 'Client portfolio review calls', 10, .3, .3, .5, .7, .9, 'Advisory skills'),
  T('Relationship Manager', 'Prepare client reports', 6, .9, .8, .9, .2, 0, 'Financial analysis'),
  T('Relationship Manager', 'CRM data entry', 5, 1, 1, .4, .1, 0, 'Pipeline strategy'),
  T('Relationship Manager', 'Onboard new clients', 6, .5, .6, .4, .5, .8, 'Consultative selling'),
  T('Compliance Analyst', 'Transaction monitoring alerts', 12, .9, .9, 1, .4, 0, 'Risk modelling'),
  T('Compliance Analyst', 'Regulatory circular review', 6, .3, .5, .4, .9, 0, 'Regulatory interpretation'),
  T('Compliance Analyst', 'Audit evidence preparation', 6, .8, .9, .6, .3, 0, 'Audit strategy'),
  T('Compliance Analyst', 'Advise business on new products', 4, .1, .3, .3, 1, .5, 'Stakeholder advisory'),
  T('Product Manager', 'Write PRDs and user stories', 6, .6, .5, .3, .6, .2, 'Product strategy'),
  T('Product Manager', 'Customer interviews', 4, .2, .1, .3, .8, .9, 'User research'),
  T('Product Manager', 'Prioritise the roadmap', 5, .2, .3, .6, 1, .4, 'Prioritisation'),
  T('Product Manager', 'Status updates & release notes', 4, .9, .7, .4, .2, .1, 'Stakeholder management'),
  T('Product Manager', 'Analyse feature metrics', 5, .6, .5, 1, .6, 0, 'Product analytics'),
  T('Sales Executive', 'Prospecting & cold outreach', 10, .8, .6, .5, .3, .4, 'Account research'),
  T('Sales Executive', 'Discovery and demo calls', 10, .2, .2, .3, .7, .9, 'Consultative selling'),
  T('Sales Executive', 'Update CRM & forecasts', 5, 1, .9, .6, .2, 0, 'Pipeline management'),
  T('Sales Executive', 'Negotiate & close deals', 6, .1, .2, .3, .9, .8, 'Negotiation'),
  T('Marketing Executive', 'Write social posts & ad copy', 8, .7, .4, .2, .4, .3, 'Brand voice'),
  T('Marketing Executive', 'Campaign performance reports', 6, .9, .8, 1, .3, 0, 'Marketing analytics'),
  T('Marketing Executive', 'Plan campaigns & positioning', 6, .2, .2, .5, .9, .5, 'Positioning'),
  T('Marketing Executive', 'Coordinate with agencies & designers', 5, .4, .4, .1, .5, .7, 'Creative direction'),
  T('Accountant', 'Invoice processing & reconciliation', 12, 1, 1, .9, .2, 0, 'Process automation'),
  T('Accountant', 'Month-end close', 6, .7, .9, .9, .5, 0, 'Financial controls'),
  T('Accountant', 'Tax & GST filings', 5, .7, 1, .8, .5, 0, 'Tax planning'),
  T('Accountant', 'Advise managers on budgets', 3, .2, .3, .6, .9, .5, 'Business partnering'),
];

export const ROLES = [...new Set(ROLE_TASKS.map((t) => t.role))];

// Checked in order: more specific titles first ("engineering manager" before "engineer").
const ALIASES = [
  [/engineering manager|tech lead|team lead.*eng|head of engineering|\bcto\b/i, 'Engineering Manager'],
  [/product manager|product owner|\bpm\b/i, 'Product Manager'],
  [/relationship manager|account manager|wealth/i, 'Relationship Manager'],
  [/analyst.*data|data.*analyst|\bbi\b|business intelligence|analytics/i, 'Data Analyst'],
  [/compliance|risk|audit/i, 'Compliance Analyst'],
  [/\bhr\b|human resources|people (partner|ops|operations)|talent|recruit/i, 'HR Business Partner'],
  [/support|customer (service|care|success)|helpdesk|call cent(re|er)/i, 'Support Associate'],
  [/sales|business development|\bbde\b|\bbdm\b/i, 'Sales Executive'],
  [/marketing|growth|content|brand|seo|social media/i, 'Marketing Executive'],
  [/account(ant|s)|finance|\bca\b|bookkeep/i, 'Accountant'],
  [/engineer|developer|\bsde\b|programmer|devops|backend|frontend|full ?stack/i, 'Software Engineer'],
];

/** Best library role for a free-text job title (null if nothing fits). */
export function matchRole(title = '') {
  const exact = ROLES.find((r) => r.toLowerCase() === title.toLowerCase().trim());
  if (exact) return exact;
  return ALIASES.find(([re]) => re.test(title))?.[1] ?? null;
}
