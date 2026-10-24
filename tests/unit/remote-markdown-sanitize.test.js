// The changelog modal renders GitHub-fetched markdown straight into
// dangerouslySetInnerHTML. These pin the sanitization that keeps a hostile
// upstream CHANGELOG.md from executing inside the authenticated dashboard.
import { describe, expect, it } from "vitest";
import { marked } from "marked";

import { renderRemoteMarkdown } from "@/shared/utils/remoteMarkdown";

const render = (md) => renderRemoteMarkdown(marked, md);

describe("renderRemoteMarkdown", () => {
  it("escapes raw HTML blocks instead of emitting them", () => {
    const html = render("<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("escapes quotes and angle brackets inside attribute-bearing markup", () => {
    expect(render('<div onclick="steal()">text</div>')).not.toContain('onclick="');
  });

  it("neutralizes script-bearing link URLs but keeps the label", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("neutralizes data: and vbscript: URLs", () => {
    expect(render("[a](data:text/html;base64,PHNjcmlwdD4=)")).not.toContain("data:text/html");
    expect(render("[a](vbscript:msgbox)")).not.toContain("vbscript:");
  });

  it("keeps ordinary markdown intact", () => {
    const html = render(
      ["# Title", "", "- **bold** item", "", "[link](https://example.com/a?b=1&c=2)", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "`code <b>`"].join("\n")
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">link</a>');
    expect(html).toContain("<table");
    expect(html).toContain("<code>code &lt;b&gt;</code>");
  });
});
