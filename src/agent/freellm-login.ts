/**
 * FreeLLM proxy login check.
 * A key is accepted when the proxy catalog returns model ids.
 */
import { fetchProxyCatalog } from "./providers-manager.js";

export type FreeLLMLoginResult =
  | { ok: true; modelCount: number }
  | { ok: false; reason: "unauthorized" | "empty" | "unreachable" };

export async function verifyFreeLLMLogin(
  apiUrl: string,
  apiKey: string,
): Promise<FreeLLMLoginResult> {
  try {
    const ids = await fetchProxyCatalog(apiUrl, apiKey);
    if (ids.length === 0) return { ok: false, reason: "empty" };
    return { ok: true, modelCount: ids.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\((?:401|403)\)/.test(message)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (message.includes("no model ids")) {
      return { ok: false, reason: "empty" };
    }
    return { ok: false, reason: "unreachable" };
  }
}
