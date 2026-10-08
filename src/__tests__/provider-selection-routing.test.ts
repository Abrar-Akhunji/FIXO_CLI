import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentClient } from "../agent/agent-client.js";
import { ProvidersManager } from "../agent/providers-manager.js";
import { getDefaultConfig, saveConfig } from "../config.js";

test("the selected provider wins when providers can expose the same model id", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-provider-selection-"));
  const previous = process.env.FIXO_HOME;
  process.env.FIXO_HOME = stateDir;
  try {
    const config = getDefaultConfig();
    config._firstRunComplete = true;
    config.provider_mode = "direct";
    config.defaultModel = "shared-model";
    config.directProvider = { name: "openai", defaultModel: "shared-model" };
    config.lastSession = {
      provider: "groq",
      model: "shared-model",
      updatedAt: new Date().toISOString(),
    };
    saveConfig(config);
    ProvidersManager.add("openai", "test-openai-key");
    ProvidersManager.add("groq", "test-groq-key");

    const client = new AgentClient("", undefined, false, "direct");
    const resolve = (client as unknown as {
      resolveDirectConfig(model: string): { providerName: string } | null;
    }).resolveDirectConfig.bind(client);
    assert.equal(resolve("shared-model")?.providerName, "groq");
    ProvidersManager.remove("groq");
    assert.equal(resolve("shared-model"), null);
  } finally {
    ProvidersManager.remove("openai");
    ProvidersManager.remove("groq");
    if (previous === undefined) delete process.env.FIXO_HOME;
    else process.env.FIXO_HOME = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
