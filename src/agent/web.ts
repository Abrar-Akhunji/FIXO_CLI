import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced'
});

export async function webFetch(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!response.ok) {
      return `Error fetching URL: ${response.status} ${response.statusText}`;
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, noscript, iframe, svg, nav, footer, header').remove();
    
    // Extract main content if available, else body
    let contentHtml = $('main').html() || $('article').html() || $('body').html() || html;
    
    const markdown = turndownService.turndown(contentHtml);
    return markdown || '(Page returned empty or only non-text content)';
  } catch (err: any) {
    return `Error fetching URL: ${err.message}`;
  }
}

export async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
      }
    });

    if (!response.ok) {
      return `Error performing web search: ${response.status} ${response.statusText}`;
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: string[] = [];
    
    $('.result').each((i, elem) => {
      if (i >= 10) return false;
      const titleElem = $(elem).find('.result__title a');
      const snippetElem = $(elem).find('.result__snippet');
      
      if (titleElem.length > 0) {
        let rawUrl = titleElem.attr('href') || '';
        if (rawUrl.startsWith('//duckduckgo.com/l/?')) {
            const urlParamMatch = rawUrl.match(/uddg=([^&]+)/);
            if (urlParamMatch) {
                rawUrl = decodeURIComponent(urlParamMatch[1]);
            }
        }
        const title = titleElem.text().trim();
        const snippet = snippetElem.text().trim();
        results.push(`### [${title}](${rawUrl})\n${snippet}\n`);
      }
    });

    if (results.length === 0) {
      return 'No results found or search page structure changed.';
    }

    return results.join('\n');
  } catch (err: any) {
    return `Error performing web search: ${err.message}`;
  }
}
