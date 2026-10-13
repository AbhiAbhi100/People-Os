// Every agent step is recorded as a span. The UI streams these live (SSE)
// so you can *see* the multi-agent system think: routing, tool calls, SQL, retries.
export class Tracer {
  constructor(onStep = () => {}, t0 = Date.now()) {
    this.t0 = t0;
    this.steps = [];
    this.onStep = onStep;
  }
  step(agent, kind, label, detail) {
    const s = { agent, kind, label, detail, t: Date.now() - this.t0 };
    this.steps.push(s);
    try { this.onStep(s); } catch {}
    return s;
  }
  async span(agent, label, fn) {
    const start = Date.now();
    try {
      const out = await fn();
      this.step(agent, 'done', `${label} (${Date.now() - start} ms)`);
      return out;
    } catch (e) {
      this.step(agent, 'error', `${label} failed: ${e.message}`);
      throw e;
    }
  }
}
