import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cascadingReplace,
  levenshtein,
  isDisproportionateMatch,
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
} from "../agent/replacer.js";

describe("Replacer Engine", () => {
  it("levenshtein calculates string distances accurately", () => {
    assert.equal(levenshtein("", ""), 0);
    assert.equal(levenshtein("a", ""), 1);
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.equal(levenshtein("function foo()", "function foo()"), 0);
  });

  it("isDisproportionateMatch flags unsafe expansions", () => {
    assert.equal(isDisproportionateMatch("one line", "one line"), false);
    const twoLines = "line 1\nline 2";
    const sevenLines = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7";
    assert.equal(isDisproportionateMatch(sevenLines, twoLines), true);
  });

  it("Strategy 1: SimpleReplacer matches exact substring", () => {
    const content = 'const x = 10;\nconst y = 20;';
    const result = cascadingReplace(content, 'const y = 20;', 'const y = 42;');
    assert.equal(result.success, true);
    assert.equal(result.strategy, "Simple");
    assert.equal(result.newContent, 'const x = 10;\nconst y = 42;');
  });

  it("Strategy 2: LineTrimmedReplacer handles line-level indentation variations", () => {
    const content = 'function test() {\n    const a = 1;\n    const b = 2;\n}';
    // LLM searched with 2 spaces instead of 4 spaces
    const search = '  const a = 1;\n  const b = 2;';
    const replace = '  const a = 99;\n  const b = 2;';
    const result = cascadingReplace(content, search, replace);
    assert.equal(result.success, true);
    assert.equal(result.strategy, "LineTrimmed");
    assert.ok(result.newContent?.includes('const a = 99;'));
  });

  it("Strategy 3: BlockAnchorReplacer matches with slightly differing middle lines", () => {
    const content = [
      "function calculateTotal(items) {",
      "  let total = 0;",
      "  for (const item of items) {",
      "    total += item.price * item.quantity;",
      "  }",
      "  return total;",
      "}",
    ].join("\n");

    // LLM has slight typo or formatting in middle lines
    const search = [
      "function calculateTotal(items) {",
      "  let total = 0;",
      "  for (const item of items) {",
      "    total += item.price * item.qty;", // slight mismatch
      "  }",
      "  return total;",
      "}",
    ].join("\n");

    const replacement = [
      "function calculateTotal(items) {",
      "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
      "}",
    ].join("\n");

    const result = cascadingReplace(content, search, replacement);
    assert.equal(result.success, true);
    assert.equal(result.strategy, "BlockAnchor");
    assert.ok(result.newContent?.includes("items.reduce"));
  });

  it("Strategy 4: WhitespaceNormalizedReplacer handles multiple spaces and tabs", () => {
    const content = "const   total  =\t 100;";
    const search = "const total = 100;";
    const replacement = "const total = 200;";

    const result = cascadingReplace(content, search, replacement);
    assert.equal(result.success, true);
    assert.equal(result.strategy, "WhitespaceNormalized");
    assert.equal(result.newContent, "const total = 200;");
  });

  it("Strategy 5: IndentationFlexibleReplacer matches indented blocks", () => {
    const content = [
      "class Service {",
      "    init() {",
      "        const config = load();",
      "        return config;",
      "    }",
      "}",
    ].join("\n");

    // Zero-indented search
    const search = [
      "init() {",
      "    const config = load();",
      "    return config;",
      "}",
    ].join("\n");

    const replacement = [
      "    init() {",
      "        return load();",
      "    }",
    ].join("\n");

    const result = cascadingReplace(content, search, replacement);
    assert.equal(result.success, true);
    assert.ok(result.newContent?.includes("return load();"));
  });

  it("Strategy 6: EscapeNormalizedReplacer handles escaped quotes and newlines", () => {
    const content = 'const str = "hello world";';
    // LLM using smart unicode quotes
    const search = 'const str = “hello world”;';
    const replacement = 'const str = "hi world";';

    const result = cascadingReplace(content, search, replacement);
    assert.equal(result.success, true);
    assert.equal(result.strategy, "EscapeNormalized");
    assert.equal(result.newContent, 'const str = "hi world";');
  });

  it("Strategy 7: TrimmedBoundaryReplacer trims accidental blank lines in search", () => {
    const content = "function foo() {\n  return 1;\n}";
    const search = "\n\nfunction foo() {\n  return 1;\n}\n\n";
    const replacement = "function foo() {\n  return 2;\n}";

    const result = cascadingReplace(content, search, replacement);
    assert.equal(result.success, true);
    assert.equal(result.newContent, "function foo() {\n  return 2;\n}");
  });

  it("Rejects identical oldString and newString", () => {
    const result = cascadingReplace("content", "same", "same");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("identical"));
  });

  it("Rejects empty oldString", () => {
    const result = cascadingReplace("content", "", "new");
    assert.equal(result.success, false);
    assert.ok(result.error?.includes("cannot be empty"));
  });

  it("Enforces uniqueness when expectUnique is true", () => {
    const content = "foo\nbar\nfoo";
    const result = cascadingReplace(content, "foo", "baz", { expectUnique: true });
    assert.equal(result.success, false);
    assert.equal(result.occurrences, 2);
  });

  it("Replaces all occurrences when replaceAll is true", () => {
    const content = "foo\nbar\nfoo";
    const result = cascadingReplace(content, "foo", "baz", { replaceAll: true });
    assert.equal(result.success, true);
    assert.equal(result.newContent, "baz\nbar\nbaz");
  });
});
