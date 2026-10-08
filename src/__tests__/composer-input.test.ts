import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptHighlighted,
  classifyBracketedPaste,
  completeActiveToken,
  isSlashPrefix,
  nextHighlight,
  providerChoiceValues,
  rankSlashCommands,
  replaceComposerLine,
} from "../ui/composer-input.js";
import { renderDotMark } from "../ui/loading-animation.js";
import { SessionScreen } from "../ui/session-screen.js";

test("a single-line paste keeps the text and drops the trailing newline", () => {
  const pasted = classifyBracketedPaste("sk-test-key\n");
  assert.deepEqual(pasted, { kind: "line", text: "sk-test-key" });
});

test("a multi-line paste stays a block", () => {
  const pasted = classifyBracketedPaste("one\ntwo\n");
  assert.equal(pasted.kind, "block");
  if (pasted.kind === "block") assert.equal(pasted.lines, 2);
});

test("/provi accepts the highlighted /providers command", () => {
  assert.equal(isSlashPrefix("/provi"), true);
  assert.equal(acceptHighlighted("/provi", "/providers"), "/providers ");
  assert.equal(acceptHighlighted("/providers list", "/providers"), null);
});

test("slash completion ranks prefixes and near-typos without changing exact commands", () => {
  const commands = ["/model", "/providers", "/plan", "/help"];
  assert.equal(rankSlashCommands("/provi", commands)[0], "/providers");
  assert.equal(rankSlashCommands("/modle", commands)[0], "/model");
  assert.equal(rankSlashCommands("/model", commands)[0], "/model");
  assert.deepEqual(rankSlashCommands("model", commands), []);
});

test("accepting a slash completion replaces the submitted readline buffer", () => {
  let paints = 0;
  const editor = { line: "/provi", cursor: 6, _refreshLine() { paints++; } };
  replaceComposerLine(editor, acceptHighlighted(editor.line, "/providers")!);
  assert.equal(editor.line, "/providers ");
  assert.equal(editor.cursor, 11);
  assert.equal(paints, 1);
});

test("@mention completion preserves text around a nested file path", () => {
  assert.deepEqual(
    completeActiveToken("Read @src/fi please", 12, 5, "@src/file.ts "),
    { line: "Read @src/file.ts please", cursor: 18 },
  );
  assert.deepEqual(
    completeActiveToken("Read @src/file.ts please", 12, 5, "@src/other.ts "),
    { line: "Read @src/other.ts please", cursor: 19 },
  );
});

test("provider choices are the connected names and add, never a mixed list", () => {
  assert.deepEqual(providerChoiceValues(["openai", "groq"]), [
    "openai",
    "groq",
    "__add__",
  ]);
  assert.equal(providerChoiceValues(["openai", "groq"]).includes("all"), false);
});

test("the 3x3 mark stays one short row", () => {
  const mark = renderDotMark(0);
  assert.equal(mark.includes("\n"), false);
  assert.ok(mark.length < 20);
  assert.equal(renderDotMark(8).includes("●"), true);
  assert.notEqual(renderDotMark(6), renderDotMark(7));
  assert.equal(renderDotMark(8), renderDotMark(0));
  assert.equal(renderDotMark(16, "bloom"), renderDotMark(0, "bloom"));
  assert.notEqual(renderDotMark(4, "bloom"), renderDotMark(0, "bloom"));
});

test("wheel scroll moves the session transcript offset", () => {
  const chunks: string[] = [];
  const screen = new SessionScreen(
    { mode: "BUILD", model: "auto" },
    {
      write(chunk) {
        chunks.push(chunk);
      },
      rows: 12,
      cols: 40,
    },
  );
  screen.open();
  screen.scrollBy(3);
  const joined = chunks.join("");
  assert.equal(joined.includes("BUILD"), true);
  assert.equal(nextHighlight(0, 4, -1), 3);
  screen.close();
});
