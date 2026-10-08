// Simulierte Sessions, damit Agent City auch ohne laufendes Claude Code vorführbar ist.
const TOOLS = [
  ['Read', 'library', ['server.ts', 'App.tsx', 'schema.prisma', 'README.md', 'auth.ts']],
  ['Grep', 'library', ['useOrders', 'TODO', 'createClient', 'export default']],
  ['Glob', 'library', ['src/**/*.tsx', '**/*.test.ts']],
  ['Edit', 'workbench', ['OrderList.tsx', 'api/routes.ts', 'styles.css', 'menu.service.ts']],
  ['Write', 'workbench', ['migration_042.sql', 'useCart.ts', 'Checkout.tsx']],
  ['Bash', 'terminal', ['Tests ausführen', 'Build starten', 'Git-Status prüfen', 'Abhängigkeiten installieren']],
  ['WebSearch', 'portal', ['three.js shadow bias', 'Stripe webhook retries', 'Expo SDK changelog']],
  ['WebFetch', 'portal', ['docs.expo.dev', 'threejs.org', 'developer.apple.com']],
];
const SUB_TYPES = [
  ['Explore', 'Codebasis nach Auth-Flows durchsuchen'],
  ['general-purpose', 'Recherche Zahlungsanbieter'],
  ['code-reviewer', 'Review der Bestell-API'],
  ['frontend-developer', 'Checkout-Screen umsetzen'],
  ['test-automator', 'E2E-Tests für Warenkorb'],
  ['Plan', 'Migrationsplan entwerfen'],
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Demo {
  constructor(store) {
    this.store = store;
    this.agents = new Map();
    this.n = 0;
    const now = Date.now();
    this.addMain('restaurant-app', 'Bestellungen in Echtzeit synchronisieren', now - 22 * 60e3);
    this.addMain('agentcity', '3D-Stadt für KI-Coding-Agenten', now - 8 * 60e3);
    this.addMain('ai-trade-app', 'Backtesting-Dashboard', now - 41 * 60e3, 'waiting_user');
    // zweites Haus im selben Ordner: ein Haus ist ein Auftrag, nicht der Projektordner
    this.addMain('restaurant-app', 'Checkout-Flow prüfen', now - 3 * 60e3);
  }

  addMain(project, title, startedAt, status = 'thinking') {
    const id = `m:demo-${++this.n}`;
    this.agents.set(id, {
      id, kind: 'main', sessionId: id, house: id, parentId: null, toolId: 'claude', source: 'demo', controllable: false, project, cwd: `~/myProjects/${project}`,
      title, description: null, agentType: null, model: 'claude-opus-5-5',
      status, tool: null, category: null, detail: null,
      lastText: 'Ich schaue mir zuerst die bestehende Struktur an und lege dann los.',
      lastPrompt: 'mach das bitte professionell und teste es im Browser',
      lastActivity: Date.now(), startedAt, tokens: { input: 1200, output: 900, cache: 180000 }, toolCount: 0, events: [],
      nextAt: Date.now() + 800 + Math.random() * 1500,
    });
  }

  spawnSub(parent) {
    const [type, desc] = pick(SUB_TYPES);
    const id = `s:demo-${++this.n}`;
    this.agents.set(id, {
      id, kind: 'sub', sessionId: parent.sessionId, house: parent.house, parentId: parent.id, toolId: 'claude', source: 'demo', controllable: false, project: parent.project, cwd: parent.cwd,
      title: null, description: desc, agentType: type, model: type === 'Explore' ? 'claude-haiku-4-5' : 'claude-sonnet-5-5',
      status: 'thinking', tool: null, category: null, detail: null, lastText: null, lastPrompt: null,
      lastActivity: Date.now(), startedAt: Date.now(), tokens: { input: 0, output: 0, cache: 0 }, toolCount: 0, events: [],
      nextAt: Date.now() + 1500, life: 6 + Math.floor(Math.random() * 8),
    });
    this.event(parent, { kind: 'tool', tool: 'Agent', category: 'meeting', label: desc });
  }

  event(a, ev) {
    a.events.push({ t: Date.now(), ...ev });
    if (a.events.length > 14) a.events.shift();
  }

  step() {
    const now = Date.now();
    for (const a of [...this.agents.values()]) {
      if (now < a.nextAt) continue;
      a.nextAt = now + 2200 + Math.random() * 3800;
      a.lastActivity = now;
      if (a.kind === 'sub' && a.status === 'done') { this.agents.delete(a.id); continue; }
      if (a.kind === 'main' && a.status === 'waiting_user') {
        if (Math.random() < 0.25) { a.status = 'thinking'; this.event(a, { kind: 'prompt', label: 'ok weiter, sieht gut aus' }); }
        continue;
      }
      const subs = [...this.agents.values()].filter((s) => s.parentId === a.id && s.status !== 'done').length;
      const r = Math.random();
      if (a.kind === 'sub' && --a.life <= 0) {
        a.status = 'done'; a.tool = a.category = a.detail = null;
        a.lastText = 'Fertig – Ergebnis an den Hauptagenten übergeben.';
        a.nextAt = now + 5000;
      } else if (a.kind === 'main' && r < 0.14 && subs < 4) {
        a.status = 'tool'; a.tool = 'Agent'; a.category = 'meeting'; a.detail = 'Subagenten starten';
        a.toolCount++;
        this.spawnSub(a);
        if (Math.random() < 0.5) this.spawnSub(a);
      } else if (a.kind === 'main' && r < 0.2) {
        a.status = 'waiting_user'; a.tool = a.category = a.detail = null;
        a.lastText = 'Fertig. Soll ich auch die Tests ergänzen?';
        this.event(a, { kind: 'text', label: a.lastText });
      } else if (r < 0.38) {
        a.status = 'thinking'; a.tool = a.category = a.detail = null;
      } else {
        const [tool, cat, details] = pick(TOOLS);
        a.status = 'tool'; a.tool = tool; a.category = cat; a.detail = pick(details);
        a.toolCount++;
        this.event(a, { kind: 'tool', tool, category: cat, label: a.detail });
      }
      a.tokens.input += Math.floor(Math.random() * 3000);
      a.tokens.cache += Math.floor(Math.random() * 40000);
      a.tokens.output += Math.floor(Math.random() * 900);
    }
    this.emit();
  }

  emit() {
    const agents = [...this.agents.values()].map(({ nextAt, life, ...rest }) => ({ ...rest, events: [...rest.events] }));
    this.store.applySnapshot({ now: Date.now(), agents });
  }

  start() { this.emit(); this.timer = setInterval(() => this.step(), 700); }
  stop() { clearInterval(this.timer); }
}
