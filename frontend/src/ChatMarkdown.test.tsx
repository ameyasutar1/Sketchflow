import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMarkdown } from "./ChatMarkdown";

function render(content: string) {
  const element = document.createElement("div");
  element.innerHTML = renderToStaticMarkup(<ChatMarkdown content={content} />);
  return element;
}

describe("assistant message formatting", () => {
  it("renders the diagram explanation as bold labels and nested lists", () => {
    const result = render("The diagram includes:\n\n* **Encoder**\n  * Attention\n  * Feed forward\n* **Decoder**");
    expect(result.querySelector("strong")?.textContent).toBe("Encoder");
    expect(result.querySelectorAll("ul ul li")).toHaveLength(2);
  });
  it("renders math, code, and tables", () => {
    const result = render("$x^2$\n\n```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(result.querySelector(".katex")).not.toBeNull();
    expect(result.querySelector("pre code")?.textContent).toContain("const x");
    expect(result.querySelector(".chat-table td")?.textContent).toBe("1");
  });
  it("handles incomplete streaming markup and does not render unsafe HTML or links", () => {
    expect(() => render("**Encoder\n\n```python\nx =")).not.toThrow();
    const result = render('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)');
    expect(result.querySelector("script")).toBeNull();
    expect(result.querySelector("a")?.getAttribute("href")).not.toMatch(/^javascript:/);
  });
});
