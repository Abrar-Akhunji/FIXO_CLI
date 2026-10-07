import { webFetch, webSearch } from "../web.js";

export async function executeWebFetch(args: { url: string }): Promise<string> {
  if (!args.url || typeof args.url !== "string") {
    return "Error: web_fetch requires a valid 'url' parameter.";
  }
  return await webFetch(args.url);
}

export async function executeWebSearch(args: { query: string }): Promise<string> {
  if (!args.query || typeof args.query !== "string") {
    return "Error: web_search requires a valid 'query' parameter.";
  }
  return await webSearch(args.query);
}
