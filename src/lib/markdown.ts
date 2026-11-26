/**
 * Markdown → sanitised HTML. Model output can never inject script, styles,
 * forms or tracking pixels: DOMPurify strips them and remote images are
 * removed entirely (an <img src="https://…"> would leak your IP and the fact
 * that you read the message).
 */

import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const language = (lang ?? "").trim().split(/\s+/)[0] || "text";
      return (
        `<div class="code"><div class="code-head"><span>${esc(language)}</span>` +
        `<button type="button" class="code-copy" data-action="copy-code">Copy</button></div>` +
        `<pre><code>${esc(text)}</code></pre></div>`
      );
    },
    table(token: Tokens.Table) {
      // Wrap tables so they scroll sideways on phones instead of breaking the layout.
      const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
      const body = token.rows
        .map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
        .join("");
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    },
  },
});

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute("href");
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^(data:image\/|blob:)/i.test(src)) node.remove();
    }
  });
}

export function renderMarkdown(md: string): string {
  hook();
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "video", "audio", "source"],
    FORBID_ATTR: ["style"],
  });
}
