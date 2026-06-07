/**
 * `webFetch` — moved out of the legacy `src/agent/web.ts` so
 * the search chain stays self-contained. Identical semantics
 * to the original (HTML → Markdown via cheerio + turndown).
 */
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export async function webFetch(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    if (!response.ok) {
      return `Error fetching URL: ${response.status} ${response.statusText}`;
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg, nav, footer, header').remove();
    const contentHtml =
      $('main').html() || $('article').html() || $('body').html() || html;
    const markdown = turndownService.turndown(contentHtml);
    return markdown || '(Page returned empty or only non-text content)';
  } catch (err: unknown) {
    return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
  }
}
