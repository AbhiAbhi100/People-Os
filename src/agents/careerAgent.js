// Career Agent: "What work should humans do, and what should AI handle?"
// The scoring is deterministic and explainable (see WEIGHTS in tools/registry.js);
// the LLM, if present, only writes the personal narrative on top of the numbers.
import { z } from 'zod';
import { callTool } from '../tools/registry.js';
import { chatJSON, isOffline } from '../llm/provider.js';

const ROLE_HINT = /(software engineer|engineering manager|data analyst|support associate|hr business partner|relationship manager|compliance analyst)/i;

export async function careerAgent({ query, ctx, tracer }) {
  const role = query.match(ROLE_HINT)?.[1];
  const r = await callTool('career_insights', role ? { role } : {}, ctx);
  if (r.error) return { agent: 'career', confidence: 0.4, text: `${r.error} I have task models for: ${r.available_roles.join(', ')}.` };
  tracer.step('career', 'tool', `career_insights(${r.role}) → ${r.tasks.length} tasks scored`, r.tasks.map((t) => `${t.score.toString().padStart(3)}  ${t.bucket.padEnd(16)} ${t.task}`).join('\n'));

  const by = (b) => r.tasks.filter((t) => t.bucket === b);
  let text = `For a **${r.role}**, about **${r.hours_freed_per_week} of ${r.total_hours} hrs/week** could be freed by AI. ` +
    `Automate: ${by('Automate').map((t) => t.task.toLowerCase()).join(', ') || '—'}. ` +
    `Keep human-led: ${by('Human-led').map((t) => t.task.toLowerCase()).join(', ') || '—'}.\n\n` +
    `**Skills to double down on:** ${r.skills_to_grow.join(', ')}.\n\n` +
    `**Adjacent roles** with similar experience and more human-led work: ${r.adjacent_roles.map((a) => `${a.role} (${a.similarity}% similar)`).join(', ')}.`;

  if (!isOffline()) {
    try {
      const out = await chatJSON({
        system: 'You are a thoughtful career coach. Using ONLY the analysis JSON, write a warm, specific 4-6 sentence note to the employee: what AI will take off their plate, where their human edge is, 2 concrete next steps for this quarter. No hype, no fear-mongering. Markdown bold allowed.',
        schema: z.object({ note: z.string().describe('the personal note') }), name: 'career_note',
        messages: [{ role: 'user', content: JSON.stringify({ employee: ctx.user.name, ...r }) }],
      });
      text = out.note;
      tracer.step('career', 'llm', 'personal narrative written from scored analysis');
    } catch { tracer.step('career', 'warn', 'narrative LLM failed; using template'); }
  }

  return {
    agent: 'career', confidence: 0.9, text,
    career: r,
    chart: {
      type: 'bar', horizontal: true, title: `AI-automation score by task — ${r.role}`, x: 'task', y: 'score',
      labels: r.tasks.map((t) => t.task), values: r.tasks.map((t) => t.score), buckets: r.tasks.map((t) => t.bucket),
    },
  };
}
