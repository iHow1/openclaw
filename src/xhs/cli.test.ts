import { describe, expect, it } from "vitest";
import { collectCleanupTitles, parseCommand, usage } from "./cli.ts";

describe("usage", () => {
  it("does not mention the old sibling repo bridge", () => {
    expect(usage()).not.toContain("xiaohongshu-mcp");
    expect(usage()).not.toContain("--root");
  });
});

describe("parseCommand", () => {
  it("accepts the pnpm double-dash form", () => {
    expect(
      parseCommand([
        "--",
        "fill",
        "--title",
        "标题",
        "--content",
        "正文",
        "--image",
        "/tmp/test.png",
      ]),
    ).toMatchObject({
      command: "fill",
      content: "正文",
      images: ["/tmp/test.png"],
      title: "标题",
    });
  });

  it("rejects long-article mode because it is outside the bridge scope", () => {
    expect(() =>
      parseCommand([
        "fill",
        "--mode",
        "long-article",
        "--title",
        "标题",
        "--content",
        "正文",
        "--image",
        "/tmp/test.png",
      ]),
    ).toThrow("long-article mode is outside the current XHS bridge scope.");
  });

  it("prints usage for unsupported commands", () => {
    expect(() => parseCommand(["unknown"])).toThrow(usage());
  });

  it("parses cleanup-published in dry-run mode by default", () => {
    expect(
      parseCommand(["cleanup-published", "--report-file", "/tmp/xhs-smoke-report.json"]),
    ).toMatchObject({
      apply: false,
      cleanupReportFiles: ["/tmp/xhs-smoke-report.json"],
      command: "cleanup-published",
    });
  });
});

describe("collectCleanupTitles", () => {
  it("deduplicates inline titles and report titles", () => {
    expect(
      collectCleanupTitles(
        ["  Title A  ", "Title A"],
        [{ livePublishTitle: "Title B" }, { livePublishTitle: "Title A" }, {}],
      ),
    ).toEqual(["Title A", "Title B"]);
  });
});
