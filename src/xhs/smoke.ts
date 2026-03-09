import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { countPageTargetsByPrefix, XHS_LOGIN_CHECK_URL } from "./bridge.ts";
import { runXhsCli } from "./cli.ts";

const LIVE_PUBLISH_ENV = "OPENCLAW_XHS_ALLOW_LIVE_PUBLISH";
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUs8AAAAASUVORK5CYII=";

export type SmokePublishCommand = "click-publish" | "none" | "publish";

export interface SmokeOptions {
  account?: string;
  allowLivePublish: boolean;
  headless: boolean;
  publishCommand: SmokePublishCommand;
  reportDir?: string;
}

export interface SmokeStepResult {
  detail: string;
  name: string;
  status: "passed" | "skipped";
}

export interface SmokeReport {
  artifacts: SmokeArtifact[];
  cleanupNotes: string[];
  draftedTitle: string;
  livePublishTitle?: string;
  publishCommand: SmokePublishCommand;
  reportDir: string;
  reportPath: string;
  steps: SmokeStepResult[];
}

export interface SmokeArtifact {
  auditDir: string;
  label: "draft" | "publish" | "ready-to-publish";
  summaryPath: string;
}

function sharedCliArgs(options: SmokeOptions): string[] {
  return [
    ...(options.account ? ["--account", options.account] : []),
    ...(options.headless ? ["--headless"] : []),
  ];
}

function buildSmokeTitle(prefix: string): string {
  return `${prefix} ${new Date().toISOString().replace("T", " ").slice(0, 19)}`;
}

function ensureLivePublishEnabled(options: SmokeOptions): void {
  if (options.publishCommand === "none") {
    return;
  }
  if (!options.allowLivePublish) {
    throw new Error(`Live publish smoke requires --allow-live-publish and ${LIVE_PUBLISH_ENV}=1.`);
  }
  if (process.env[LIVE_PUBLISH_ENV] !== "1") {
    throw new Error(`Set ${LIVE_PUBLISH_ENV}=1 before running live publish smoke.`);
  }
}

export function parseSmokeArgs(argv: string[]): SmokeOptions {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const parsed = parseArgs({
    allowPositionals: false,
    args: normalizedArgv,
    options: {
      account: { type: "string" },
      "allow-live-publish": { default: false, type: "boolean" },
      headless: { default: false, type: "boolean" },
      "publish-command": { default: "none", type: "string" },
      "report-dir": { type: "string" },
    },
    strict: true,
  });

  const publishCommand = parsed.values["publish-command"];
  if (
    publishCommand !== "none" &&
    publishCommand !== "click-publish" &&
    publishCommand !== "publish"
  ) {
    throw new Error(`Unsupported --publish-command: ${publishCommand}`);
  }

  return {
    account: parsed.values.account,
    allowLivePublish: parsed.values["allow-live-publish"] ?? false,
    headless: parsed.values.headless ?? false,
    publishCommand,
    reportDir: parsed.values["report-dir"],
  };
}

async function resolveReportDir(explicitDir?: string): Promise<string> {
  const reportDir =
    explicitDir ?? (await mkdtemp(path.join(os.tmpdir(), "openclaw-xhs-smoke-report-")));
  await mkdir(reportDir, { recursive: true });
  return reportDir;
}

function summaryPathForDir(auditDir: string): string {
  return path.join(auditDir, "summary.json");
}

async function writeSmokeReport(
  reportDir: string,
  report: Omit<SmokeReport, "reportPath">,
): Promise<SmokeReport> {
  const reportPath = path.join(reportDir, "smoke-report.json");
  const finalized: SmokeReport = { ...report, reportPath };
  await writeFile(reportPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  return finalized;
}

async function createSmokeImage(): Promise<{ cleanup(): Promise<void>; imagePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-xhs-smoke-"));
  const imagePath = path.join(dir, "smoke.png");
  await writeFile(imagePath, Buffer.from(TEST_IMAGE_BASE64, "base64"));
  return {
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
    imagePath,
  };
}

async function expectCliSuccess(args: string[]): Promise<void> {
  const code = await runXhsCli(args);
  if (code !== 0) {
    throw new Error(`Expected success from xhs ${args.join(" ")}, got exit code ${code}.`);
  }
}

async function expectCliFailure(
  args: string[],
  expectedMessages: string | string[],
): Promise<void> {
  const accepted = Array.isArray(expectedMessages) ? expectedMessages : [expectedMessages];
  try {
    const code = await runXhsCli(args);
    if (code === 0) {
      throw new Error(`Expected failure from xhs ${args.join(" ")}, but it succeeded.`);
    }
    throw new Error(
      `Expected an error matching one of ${accepted.join(" | ")}, but xhs ${args.join(" ")} exited with code ${code}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!accepted.some((expectedMessage) => message.includes(expectedMessage))) {
      throw error;
    }
  }
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  ensureLivePublishEnabled(options);

  const reportDir = await resolveReportDir(options.reportDir);
  const steps: SmokeStepResult[] = [];
  const artifacts: SmokeArtifact[] = [];
  const cleanupNotes: string[] = [];
  const cliArgs = sharedCliArgs(options);
  const smokeImage = await createSmokeImage();
  const draftedTitle = buildSmokeTitle("OpenClaw XHS smoke draft");
  let livePublishTitle: string | undefined;

  try {
    await expectCliSuccess(["check-login", ...cliArgs]);
    const creatorTargetsAfterFirstCheck = await countPageTargetsByPrefix(XHS_LOGIN_CHECK_URL);
    await expectCliSuccess(["check-login", ...cliArgs]);
    const creatorTargetsAfterSecondCheck = await countPageTargetsByPrefix(XHS_LOGIN_CHECK_URL);
    if (creatorTargetsAfterSecondCheck !== creatorTargetsAfterFirstCheck) {
      throw new Error(
        `Creator target count changed after repeated check-login: ${creatorTargetsAfterFirstCheck} -> ${creatorTargetsAfterSecondCheck}`,
      );
    }
    steps.push({
      detail: `creator tabs stable at ${creatorTargetsAfterSecondCheck}`,
      name: "check-login reuses creator tab",
      status: "passed",
    });

    await expectCliSuccess([
      "draft",
      ...cliArgs,
      "--audit-dir",
      path.join(reportDir, "draft"),
      "--title",
      draftedTitle,
      "--content",
      "执行层 smoke test，请忽略。",
      "--image",
      smokeImage.imagePath,
    ]);
    artifacts.push({
      auditDir: path.join(reportDir, "draft"),
      label: "draft",
      summaryPath: summaryPathForDir(path.join(reportDir, "draft")),
    });
    steps.push({
      detail: draftedTitle,
      name: "draft fills and saves",
      status: "passed",
    });

    await expectCliSuccess(["check-login", ...cliArgs]);
    await expectCliFailure(
      ["save-draft", ...cliArgs],
      [
        "No editable Xiaohongshu compose page is open.",
        "No Chrome publish page target is available on the XHS bridge port.",
      ],
    );
    steps.push({
      detail: "No editable Xiaohongshu compose page is open.",
      name: "save-draft fails outside compose page",
      status: "passed",
    });

    if (options.publishCommand === "none") {
      steps.push({
        detail: "live publish not requested",
        name: "live publish verification",
        status: "skipped",
      });
      return await writeSmokeReport(reportDir, {
        artifacts,
        cleanupNotes,
        draftedTitle,
        publishCommand: options.publishCommand,
        reportDir,
        steps,
      });
    }

    livePublishTitle = buildSmokeTitle(`OpenClaw XHS smoke ${options.publishCommand}`);
    const livePublishAuditDir = path.join(reportDir, "publish");
    if (options.publishCommand === "click-publish") {
      await expectCliSuccess([
        "fill",
        ...cliArgs,
        "--audit-dir",
        livePublishAuditDir,
        "--title",
        livePublishTitle,
        "--content",
        "执行层 live publish smoke test，请忽略。",
        "--image",
        smokeImage.imagePath,
      ]);
      await expectCliSuccess(["click-publish", ...cliArgs]);
    } else {
      await expectCliSuccess([
        "publish",
        ...cliArgs,
        "--audit-dir",
        livePublishAuditDir,
        "--title",
        livePublishTitle,
        "--content",
        "执行层 live publish smoke test，请忽略。",
        "--image",
        smokeImage.imagePath,
      ]);
    }
    artifacts.push({
      auditDir: livePublishAuditDir,
      label: options.publishCommand === "publish" ? "publish" : "ready-to-publish",
      summaryPath: summaryPathForDir(livePublishAuditDir),
    });
    cleanupNotes.push(`Delete or archive the live smoke post manually: ${livePublishTitle}`);
    steps.push({
      detail: `${options.publishCommand}: ${livePublishTitle}`,
      name: "live publish verification",
      status: "passed",
    });
    return await writeSmokeReport(reportDir, {
      artifacts,
      cleanupNotes,
      draftedTitle,
      livePublishTitle,
      publishCommand: options.publishCommand,
      reportDir,
      steps,
    });
  } finally {
    await smokeImage.cleanup();
  }
}
