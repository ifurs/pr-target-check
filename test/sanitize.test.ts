import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { allowPolicyBody, allowPolicyCommand } from "../src/policy";
import { renderMarkdown, renderText } from "../src/report";
import type { RepoResult } from "../src/scan";
import { clean, mdCode, mdText, shellQuote } from "../src/sanitize";
import { analyzeWorkflow } from "../src/workflow";

const EVIL_FILE = ".github/workflows/x'; touch /tmp/pwned; echo '```.yml";

describe("sanitize helpers", () => {
  it("clean removes control and bidi characters and caps length", () => {
    expect(clean("a\x1b[31mb\x07c\u202ed\r")).toBe("a�[31mb�c�d�");
    expect(clean("x".repeat(10), 4)).toBe("xxxx…");
    expect(clean("tab\tand\nnewline")).toBe("tab\tand\nnewline");
  });

  it("shellQuote survives single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("markdown helpers", () => {
    expect(mdText("![x](http://e.example) <b>")).toBe("\\!\\[x\\]\\(http://e.example\\) \\<b\\>");
    expect(mdCode("a`b\nc")).toBe("`a'b c`");
  });
});

describe("untrusted input from scanned repos", () => {
  it("the allow command keeps a hostile file name inside one shell argument", () => {
    const cmd = allowPolicyCommand("o/r", EVIL_FILE, ["pull_request_target"]);
    // Run the echo part in a real POSIX shell and check it prints exactly the JSON.
    const echo = cmd.slice(0, cmd.indexOf(" | gh api"));
    let printed: string;
    try {
      printed = execFileSync("sh", ["-c", echo], { encoding: "utf8" }).trim();
    } catch {
      return; // no POSIX shell available; the unit test above still covers quoting
    }
    expect(JSON.parse(printed)).toEqual(allowPolicyBody(EVIL_FILE, ["pull_request_target"]));
  });

  it("rejects odd repo slugs in the command", () => {
    expect(allowPolicyCommand("o/r; rm -rf ~", "a.yml", [])).toContain("repos/OWNER/REPO/actions");
  });

  it("step names can't inject terminal escapes or Markdown", () => {
    const src = [
      "on: pull_request_target",
      "permissions: {}",
      "jobs:",
      "  a:",
      "    steps:",
      '      - name: "\\e]8;;http://e.example\\a![img](http://e.example/t.png)"',
      "        uses: actions/checkout@v6",
      "        with: { ref: '${{ github.head_ref }}' }",
      "      - run: make",
    ].join("\n");
    const analysis = analyzeWorkflow(EVIL_FILE, src);
    expect(analysis.findings[0]!.message).not.toContain("\x1b");
    const result: RepoResult = {
      name: "o/r\x1b[2J",
      slug: "o/r",
      files: [{ analysis, policy: { kind: "blocked-by-default" } }],
      scanned: 1,
      note: "n\x1b[0m",
    };
    const text = renderText([result]);
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    const md = renderMarkdown([result]);
    expect(md).not.toContain("![img]");
    expect(md).toContain("\\!\\[img\\]");
  });

  it("a hostile file name can't close the Markdown code fence of the allow command", () => {
    const safe = analyzeWorkflow(EVIL_FILE, "on: pull_request_target\npermissions:\n  pull-requests: write\njobs:\n  a:\n    steps: [{uses: actions/labeler@v7}]\n");
    expect(safe.risk).toBe("safe");
    const md = renderMarkdown([{ name: "o/r", slug: "o/r", files: [{ analysis: safe, policy: { kind: "blocked-by-default" } }], scanned: 1 }]);
    expect(md).toContain("````sh\necho '"); // the file name has ``` in it, so the fence is longer
    expect(md).toContain("#### ❌ `.github/workflows/x'; touch /tmp/pwned; echo ''''.yml`");
  });
});
