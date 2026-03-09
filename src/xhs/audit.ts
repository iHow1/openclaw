import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PublisherAuditSnapshot } from "./bridge.ts";
import type { XhsCommand } from "./cli.ts";

export interface AuditRequest {
  auditDir?: string;
  command: Extract<XhsCommand, "draft" | "fill" | "publish">;
  content: string;
  imagePaths: string[];
  title: string;
}

export interface AuditSummary {
  auditDir: string;
  bodyPreview: string;
  capturedAt: string;
  command: AuditRequest["command"];
  content: string;
  imagePaths: string[];
  pageUrl: string;
  previewScreenshotPath: string;
  status: "draft_saved" | "published" | "ready_to_publish";
  summaryPath: string;
  title: string;
}

function auditStatus(command: AuditRequest["command"]): AuditSummary["status"] {
  switch (command) {
    case "fill":
      return "ready_to_publish";
    case "draft":
      return "draft_saved";
    case "publish":
      return "published";
  }
}

async function resolveAuditDir(explicitDir?: string): Promise<string> {
  const targetDir =
    explicitDir ??
    process.env.OPENCLAW_XHS_AUDIT_DIR ??
    (await mkdtemp(path.join(os.tmpdir(), "openclaw-xhs-audit-")));
  await mkdir(targetDir, { recursive: true });
  return targetDir;
}

export async function writeAuditArtifacts(
  request: AuditRequest,
  snapshot: PublisherAuditSnapshot,
): Promise<AuditSummary> {
  const auditDir = await resolveAuditDir(request.auditDir);
  const previewScreenshotPath = path.join(auditDir, "preview.png");
  const summaryPath = path.join(auditDir, "summary.json");

  await writeFile(previewScreenshotPath, Buffer.from(snapshot.screenshotBase64, "base64"));

  const summary: AuditSummary = {
    auditDir,
    bodyPreview: snapshot.bodyPreview,
    capturedAt: new Date().toISOString(),
    command: request.command,
    content: request.content,
    imagePaths: request.imagePaths,
    pageUrl: snapshot.href,
    previewScreenshotPath,
    status: auditStatus(request.command),
    summaryPath,
    title: request.title,
  };

  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
