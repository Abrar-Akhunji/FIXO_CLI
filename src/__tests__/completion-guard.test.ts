import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Completion Guard Pattern", () => {
  const isImperativeTask = (task: string): boolean => {
    return /^(fix|implement|create|add|update|refactor|write|delete|remove|modify|build|generate|make|edit|repair|patch)\b/i.test(
      task.trim(),
    );
  };

  it("identifies imperative coding prompts requiring execution", () => {
    assert.equal(isImperativeTask("fix the failing test in user.test.ts"), true);
    assert.equal(isImperativeTask("implement user authentication with JWT"), true);
    assert.equal(isImperativeTask("create a new Button component"), true);
    assert.equal(isImperativeTask("refactor database connection pool"), true);
    assert.equal(isImperativeTask("add unit tests for payment service"), true);
    assert.equal(isImperativeTask("update package.json dependencies"), true);
    assert.equal(isImperativeTask("delete legacy endpoints in router"), true);
    assert.equal(isImperativeTask("repair broken regex in parser"), true);
    assert.equal(isImperativeTask("patch security vulnerability"), true);
  });

  it("identifies conversational/investigative queries as non-imperative", () => {
    assert.equal(isImperativeTask("what is the current status of the project?"), false);
    assert.equal(isImperativeTask("explain how the auth service works"), false);
    assert.equal(isImperativeTask("can you look at the logs?"), false);
    assert.equal(isImperativeTask("why is the build slow?"), false);
    assert.equal(isImperativeTask("where is the entry point defined?"), false);
  });
});
