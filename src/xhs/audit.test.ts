import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeAuditArtifacts } from "./audit.ts";

describe("writeAuditArtifacts", () => {
  it("writes summary.json and preview.png into the requested audit directory", async () => {
    const auditDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-xhs-audit-test-"));
    const summary = await writeAuditArtifacts(
      {
        auditDir,
        command: "draft",
        content: "正文",
        imagePaths: ["/tmp/test.png"],
        title: "标题",
      },
      {
        bodyPreview: "页面预览",
        hasPublish: false,
        hasSave: false,
        href: "https://creator.xiaohongshu.com/publish/publish",
        screenshotBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUs8AAAAASUVORK5CYII=",
      },
    );

    expect(summary.auditDir).toBe(auditDir);
    expect(summary.status).toBe("draft_saved");
    expect(summary.previewScreenshotPath).toBe(path.join(auditDir, "preview.png"));
    expect(summary.summaryPath).toBe(path.join(auditDir, "summary.json"));

    const stored = JSON.parse(await readFile(summary.summaryPath, "utf8")) as {
      status: string;
      title: string;
    };
    expect(stored).toMatchObject({
      status: "draft_saved",
      title: "标题",
    });
  });
});
