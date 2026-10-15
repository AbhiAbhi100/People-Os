// Handoff Agent: knows when NOT to be an AI.
// Sensitive topics (harassment, mental health, grievances, legal) skip automation entirely:
// the user gets empathy, the right human, and an optional confidential ticket they control.
import { settingsOf } from '../services/company.js';

const SENSITIVE = [
  { re: /harass|inappropriate (touch|comment|behaviou?r)|posh|molest|stalk|sexual/i, kind: 'posh' },
  { re: /depress|anxiety|panic|burn(ed|t)? ?out|suicid|self.?harm|can'?t cope|mental health|overwhelmed|breakdown/i, kind: 'wellbeing' },
  { re: /discriminat|bully|retaliat|unfair(ly)? treat|toxic manager|abus(e|ive)|threaten|shout(s|ed|ing)? at me/i, kind: 'grievance' },
  { re: /lawyer|legal action|sue\b|labou?r court|whistle.?blow|fraud/i, kind: 'legal' },
];

/** Who to contact, from the company's own settings (falls back to HR). */
function whoFor(kind, company) {
  const c = settingsOf(company).contacts;
  const hr = c.hr ? `your HR team (${c.hr})` : 'your HR team';
  if (kind === 'posh') return c.ic ? `the Internal Committee (${c.ic})` : `${hr}, who will connect you with the Internal Committee`;
  if (kind === 'wellbeing') return c.eap ? `the Employee Assistance Programme (${c.eap})` : `${hr}`;
  return c.ethics ? `${hr} or the ethics hotline (${c.ethics})` : hr;
}

export function detectSensitive(text) {
  const hit = SENSITIVE.find((s) => s.re.test(text));
  if (!hit) return null;
  // "what is the POSH policy?" is an information request, not a personal report → let the policy agent answer.
  // Crisis words always go to a human.
  const crisis = /suicid|self.?harm|end (my|it)|can'?t cope/i.test(text);
  const personal = /\b(me|my|mine|i|i'm|i am|i was|i've|someone|somebody|he|she|they|him|her|them|mujhe|mere|mera|meri)\b/i.test(text);
  const informational = /\bpolic(y|ies)\b|\bwhat is\b|\bhow (do|to|can)\b|\bprocess\b|\brules?\b/i.test(text);
  if (!crisis && informational && !personal) return null;
  return hit;
}

export function handoffAgent({ query, ctx, tracer, reason }) {
  const s = detectSensitive(query);
  const kind = s?.kind || 'low_confidence';
  tracer.step('handoff', 'route', `human handoff: ${reason || kind}`);
  if (!s) {
    return {
      agent: 'handoff', confidence: 1,
      text: "I'm not confident I can answer this correctly, and I'd rather not guess on HR matters. I can pass it to the HR team with your question attached.",
      pendingAction: null,
      handoff: { kind, suggestTicket: { category: 'HR Query', description: query } },
    };
  }
  const lead = {
    posh: "I'm really sorry you're dealing with this. You deserve to feel safe at work, and this is something a person should handle, not an AI.",
    wellbeing: "Thank you for telling me — that sounds really hard. You don't have to handle it alone, and a trained person can help far better than I can.",
    grievance: "That sounds stressful, and it's worth raising properly. A human should look at this, not an automated system.",
    legal: "This needs a human with the right context, so I won't try to advise on it.",
  }[s.kind] + (s.kind === 'wellbeing' ? "\n\nIf it would help to talk to someone right now, **Tele-MANAS** is free and confidential, 24x7: **14416**." : '')
    + (/suicid|self.?harm|end (my|it)/i.test(query) ? "\n\n**If you're in immediate danger, please call 112.**" : '');
  return {
    agent: 'handoff', confidence: 1,
    text: `${lead}\n\nThe right people: **${whoFor(s.kind, ctx.company)}**. Raising a concern in good faith is protected, and it will be handled confidentially.\n\nIf you want, I can open a **confidential ticket** so HR reaches out to you within 24 hours — only if you choose to.`,
    handoff: { kind: s.kind, suggestTicket: { category: 'Confidential', priority: 'High', description: `[${s.kind}] Employee requested a confidential conversation with HR.` } },
  };
}
