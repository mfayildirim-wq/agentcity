#!/usr/bin/env node
// Minimaler ACP-Agent für Tests (stdio). Verhalten je Prompt:
//   normal     → Gedanke, Text, tool_call „ls“, Berechtigung, bei Erlaubnis Diff + Plan + „fertig.“
//   „subagent“ → zusätzlich ein Subagent-Werkzeug (Task: Recherche)
//   „lies <pfad>“ / „schreib <pfad>“ → fs/read_text_file bzw. fs/write_text_file beim Client
//   „langsam“  → wartet bis zum Abbruch (session/cancel)
//   „absturz“  → Prozess endet mit Code 3
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const MODES = [{ id: 'confirm', name: 'Bestätigen' }, { id: 'auto', name: 'Auto' }];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map(); // sessionId → { mode, cancelled, cwd, wake }
    this.counter = 0;
  }

  async initialize() {
    return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake-agent', version: '1.0.0' } };
  }

  async authenticate() { return {}; }

  modes(id) { return { currentModeId: this.sessions.get(id).mode, availableModes: MODES }; }

  async newSession({ cwd }) {
    const sessionId = `fake-${++this.counter}`;
    this.sessions.set(sessionId, { mode: 'confirm', cancelled: false, cwd });
    return { sessionId, modes: this.modes(sessionId) };
  }

  async loadSession({ sessionId, cwd }) {
    this.sessions.set(sessionId, { mode: 'confirm', cancelled: false, cwd });
    await this.update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'alte Frage' } });
    await this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alte Antwort' } });
    return { modes: this.modes(sessionId) };
  }

  async setSessionMode({ sessionId, modeId }) {
    const s = this.sessions.get(sessionId);
    if (!s || !MODES.some((m) => m.id === modeId)) throw new Error(`Unbekannter Modus: ${modeId}`);
    s.mode = modeId;
    await this.update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: modeId });
    return {};
  }

  update(sessionId, update) { return this.conn.sessionUpdate({ sessionId, update }); }
  text(sessionId, text, kind = 'agent_message_chunk') {
    return this.update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });
  }

  async prompt({ sessionId, prompt }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} unbekannt`);
    s.cancelled = false;
    const input = prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    if (input.includes('absturz')) { process.stderr.write('Absturz wie bestellt\n'); process.exit(3); }

    await this.text(sessionId, 'überlege', 'agent_thought_chunk');
    await this.text(sessionId, 'Hallo ');

    if (input.includes('langsam')) {
      while (!s.cancelled) await sleep(10);
      return { stopReason: 'cancelled' };
    }

    const fsCmd = input.match(/^(lies|schreib) (.+)$/m);
    if (fsCmd) {
      try {
        if (fsCmd[1] === 'lies') {
          const { content } = await this.conn.readTextFile({ sessionId, path: fsCmd[2].trim() });
          await this.text(sessionId, `Inhalt: ${content}`);
        } else {
          await this.conn.writeTextFile({ sessionId, path: fsCmd[2].trim(), content: 'von fake' });
          await this.text(sessionId, 'geschrieben');
        }
      } catch (err) {
        await this.text(sessionId, `Fehler: ${err?.message ?? err}`);
      }
      return { stopReason: 'end_turn' };
    }

    if (input.includes('subagent')) {
      await this.update(sessionId, {
        sessionUpdate: 'tool_call', toolCallId: 'sub1', title: 'Task: Recherche', kind: 'other', status: 'in_progress',
        rawInput: { description: 'Recherche', subagent_type: 'Explore' }, _meta: { arena: { subagent: true } },
      });
      await this.update(sessionId, {
        sessionUpdate: 'tool_call', toolCallId: 'sub1-read', title: 'Read README.md', kind: 'read', status: 'completed',
        _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'sub1' } },
      });
      await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'sub1', status: 'completed' });
    }

    await this.update(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'pending',
      rawInput: { command: 'ls -la' },
    });
    const res = await this.conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: 't1', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls -la' } },
      options: [
        { optionId: 'allow', name: 'Erlauben', kind: 'allow_once' },
        { optionId: 'always', name: 'Immer erlauben', kind: 'allow_always' },
        { optionId: 'reject', name: 'Ablehnen', kind: 'reject_once' },
      ],
    });
    if (s.cancelled || res.outcome.outcome === 'cancelled') {
      await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
      return { stopReason: 'cancelled' };
    }
    if (res.outcome.optionId === 'reject') {
      await this.update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
      await this.text(sessionId, 'abgelehnt.');
      return { stopReason: 'end_turn' };
    }
    await this.update(sessionId, {
      sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'a.txt\nb.txt' } },
        { type: 'diff', path: `${s.cwd}/hallo.txt`, oldText: 'alt', newText: 'neu' },
      ],
    });
    await this.update(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Dateien auflisten', priority: 'high', status: 'completed' },
        { content: 'Ergebnis melden', priority: 'medium', status: 'in_progress' },
      ],
    });
    await this.update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000 });
    await this.update(sessionId, { sessionUpdate: 'session_info_update', title: 'Fake-Sitzung' });
    await this.text(sessionId, 'fertig.');
    return { stopReason: 'end_turn' };
  }

  async cancel({ sessionId }) {
    const s = this.sessions.get(sessionId);
    if (s) s.cancelled = true;
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
