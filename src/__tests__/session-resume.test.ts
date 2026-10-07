import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConversationManager,
  SessionManager,
  countUserTurns,
  rewindToTurn,
} from "../agent/conversation.js";
import {
  headlessExitCode,
  headlessStatusLine,
} from "../runtime/headless-contract.js";

test("rewindToTurn keeps the named turn and drops later ones", () => {
  const history = [
    { role: "user" as const, content: "one" },
    { role: "assistant" as const, content: "a1" },
    { role: "tool" as const, content: "tool-out", tool_call_id: "c1" },
    { role: "user" as const, content: "two" },
    { role: "assistant" as const, content: "a2" },
    { role: "user" as const, content: "three" },
    { role: "assistant" as const, content: "a3" },
  ];
  const kept = rewindToTurn(history, 2);
  assert.equal(countUserTurns(kept), 2);
  assert.equal(kept[kept.length - 1]?.content, "a2");
  assert.equal(
    kept.some((msg) => msg.content === "three"),
    false,
  );
  assert.throws(() => rewindToTurn(history, 0), /positive integer/);
});

test("listSessions filters by workspace and a prefix reloads the session", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-sessions-"));
  const original = SessionManager.getSessionsDir;
  SessionManager.getSessionsDir = () => tmp;
  try {
    const conv = new ConversationManager();
    conv.addTurn("hi", "hello");
    conv.addTurn("next", "there");
    const id = SessionManager.saveSession(
      conv,
      "auto",
      ["note.txt"],
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      undefined,
      "alpha",
      "/tmp/ws-a",
    );
    const other = new ConversationManager();
    other.addTurn("x", "y");
    SessionManager.saveSession(
      other,
      "auto",
      [],
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      undefined,
      undefined,
      "/tmp/ws-b",
    );

    const listed = SessionManager.listSessions("/tmp/ws-a");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.sessionId, id);

    const found = SessionManager.findSession(id.slice(0, 13));
    assert.equal(found.sessionId, id);
    assert.equal(found.cwd, path.resolve("/tmp/ws-a"));
    assert.deepEqual(found.modifiedFiles, ["note.txt"]);

    const rewound = new ConversationManager();
    rewound.replaceHistory(rewindToTurn(found.history, 1));
    assert.equal(countUserTurns(rewound.exportHistory()), 1);
    assert.equal(rewound.exportHistory()[0]?.content, "hi");
  } finally {
    SessionManager.getSessionsDir = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("headless status line names done, incomplete, and plan-only", () => {
  assert.equal(
    headlessStatusLine({ success: true, response: "all good" }),
    "done",
  );
  assert.equal(headlessExitCode(true), 0);
  assert.equal(
    headlessStatusLine({
      success: false,
      response: "incomplete: tool call limit reached (1)",
    }),
    "incomplete: tool call limit reached (1)",
  );
  assert.equal(headlessExitCode(false), 1);
  assert.equal(
    headlessStatusLine({ success: false, response: "plan-only" }),
    "plan-only",
  );
  assert.equal(
    headlessStatusLine({ success: false, response: "boom\nmore" }),
    "incomplete: boom",
  );
});
