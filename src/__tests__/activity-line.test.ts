import test from "node:test";
import assert from "node:assert/strict";
import { reportActivity, setActivitySink } from "../ui/activity.js";
import { parseProxyCatalog } from "../agent/providers-manager.js";

test("parseProxyCatalog keeps string ids and drops the rest", () => {
  assert.deepEqual(
    parseProxyCatalog({
      data: [{ id: "auto-route" }, { id: 3 }, { id: "" }, null, { name: "x" }],
    }),
    ["auto-route"],
  );
  assert.deepEqual(parseProxyCatalog({ models: ["nope"] }), []);
  assert.deepEqual(parseProxyCatalog(null), []);
});

test("reportActivity uses the sink and otherwise prints once", () => {
  const seen: string[] = [];
  setActivitySink((line) => {
    seen.push(line);
  });
  const original = console.log;
  let printed = 0;
  console.log = () => {
    printed += 1;
  };
  try {
    reportActivity("API 502, retry 2/5 in 3.0s");
    assert.deepEqual(seen, ["API 502, retry 2/5 in 3.0s"]);
    assert.equal(printed, 0);
    setActivitySink(null);
    reportActivity("API 502, retry 3/5 in 6.0s");
    assert.equal(printed, 1);
  } finally {
    console.log = original;
    setActivitySink(null);
  }
});
