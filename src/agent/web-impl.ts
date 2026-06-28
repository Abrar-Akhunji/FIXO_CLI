/**
 * `webFetch` — moved out of the legacy `src/agent/web.ts` so
 * the search chain stays self-contained. Identical semantics
 * to the original (HTML → Markdown via cheerio + turndown).
 */
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import dns from "node:dns/promises";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length === 4) {
    const p1 = parseInt(parts[0], 10);
    const p2 = parseInt(parts[1], 10);
    if (
      p1 === 10 ||
      p1 === 127 ||
      (p1 === 169 && p2 === 254) ||
      (p1 === 192 && p2 === 168) ||
      (p1 === 172 && p2 >= 16 && p2 <= 31) ||
      p1 === 0
    ) {
      return true;
    }
  }
  if (
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.toLowerCase().startsWith("fe8") ||
    ip.toLowerCase().startsWith("fe9") ||
    ip.toLowerCase().startsWith("fea") ||
    ip.toLowerCase().startsWith("feb")
  ) {
    return true;
  }
  return false;
}

export async function webFetch(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error fetching URL: Unsupported protocol ${parsed.protocol}`;
    }

    const hostname = parsed.hostname;
    if (hostname.toLowerCase() === "localhost") {
      return `Error fetching URL: Access to localhost is blocked for security reasons.`;
    }

    try {
      const addresses = await dns.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (isPrivateIP(addr.address)) {
          return `Error fetching URL: Resolves to a private/internal IP address (${addr.address}), which is blocked for security reasons.`;
        }
      }
    } catch (e: unknown) {
      return `Error fetching URL: Failed to resolve hostname ${hostname}`;
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    if (!response.ok) {
      return `Error fetching URL: ${response.status} ${response.statusText}`;
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, iframe, svg, nav, footer, header").remove();
    const contentHtml =
      $("main").html() || $("article").html() || $("body").html() || html;
    const markdown = turndownService.turndown(contentHtml);
    return markdown || "(Page returned empty or only non-text content)";
  } catch (err: unknown) {
    return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
  }
}
