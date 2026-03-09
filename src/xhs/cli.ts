import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { writeAuditArtifacts } from "./audit.ts";
import { XhsBridge, type FillImageTextRequest, type PublisherAuditSnapshot } from "./bridge.ts";
import { downloadImageUrls, type DownloadedImages } from "./images.ts";

export type XhsCommand =
  | "check-login"
  | "click-publish"
  | "cleanup-published"
  | "draft"
  | "fill"
  | "login"
  | "publish"
  | "save-draft";

export interface ParsedCommand {
  account?: string;
  apply: boolean;
  auditDir?: string;
  cleanupReportFiles: string[];
  cleanupTitles: string[];
  command: XhsCommand;
  content?: string;
  contentFile?: string;
  headless: boolean;
  imageUrls: string[];
  images: string[];
  mode: "image-text" | "long-article";
  title?: string;
  titleFile?: string;
}

export class NotLoggedInError extends Error {
  constructor() {
    super("NOT_LOGGED_IN");
  }
}

interface ResolvedFillRequest {
  cleanup(): Promise<void>;
  request: FillImageTextRequest;
}

const VALID_COMMANDS = new Set<XhsCommand>([
  "check-login",
  "click-publish",
  "cleanup-published",
  "draft",
  "fill",
  "login",
  "publish",
  "save-draft",
]);

export function usage(): string {
  return [
    "Usage:",
    "  pnpm xhs -- check-login",
    "  pnpm xhs -- login",
    '  pnpm xhs -- fill --title "标题" --content "正文" --image /abs/path.png',
    '  pnpm xhs -- draft --title "标题" --content "正文" --image /abs/path.png',
    "  pnpm xhs -- publish --title-file title.txt --content-file body.txt --image /abs/path.png",
    '  pnpm xhs -- save-draft [--title "标题"]',
    "  pnpm xhs -- click-publish",
    "  pnpm xhs -- cleanup-published --report-file /tmp/xhs-smoke/smoke-report.json [--apply]",
    "",
    "Options:",
    "  --account <name>      Optional account profile name",
    "  --apply               Execute destructive cleanup actions instead of dry-run output",
    "  --audit-dir <path>    Write summary.json and preview.png into this directory",
    "  --cleanup-title <t>   Exact published note title to delete (repeatable)",
    "  --report-file <path>  Read livePublishTitle from smoke-report.json (repeatable)",
    "  --headless            Run Chrome in headless mode",
    "  --mode <mode>         image-text (default); long-article is not in current bridge scope",
    "  --title <text>        Title text",
    "  --content <text>      Content text",
    "  --title-file <path>   Title file path",
    "  --content-file <path> Content file path",
    "  --image <path>        Local image path (repeatable)",
    "  --image-url <url>     Remote image URL (repeatable)",
  ].join("\n");
}

export function parseCommand(argv: string[]): ParsedCommand {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [commandRaw, ...rest] = normalizedArgv;

  if (!commandRaw || !VALID_COMMANDS.has(commandRaw as XhsCommand)) {
    throw new Error(usage());
  }

  const parsed = parseArgs({
    allowPositionals: false,
    args: rest,
    options: {
      account: { type: "string" },
      apply: { default: false, type: "boolean" },
      "audit-dir": { type: "string" },
      "cleanup-title": { default: [], multiple: true, type: "string" },
      content: { type: "string" },
      "content-file": { type: "string" },
      headless: { default: false, type: "boolean" },
      image: { default: [], multiple: true, type: "string" },
      "image-url": { default: [], multiple: true, type: "string" },
      mode: { default: "image-text", type: "string" },
      "report-file": { default: [], multiple: true, type: "string" },
      title: { type: "string" },
      "title-file": { type: "string" },
    },
    strict: true,
  });

  const mode = parsed.values.mode;
  if (mode !== "image-text" && mode !== "long-article") {
    throw new Error(`Unsupported --mode: ${mode}`);
  }
  if (mode === "long-article") {
    throw new Error("long-article mode is outside the current XHS bridge scope.");
  }

  return {
    account: parsed.values.account,
    apply: parsed.values.apply ?? false,
    auditDir: parsed.values["audit-dir"],
    cleanupReportFiles: parsed.values["report-file"] ?? [],
    cleanupTitles: parsed.values["cleanup-title"] ?? [],
    command: commandRaw as XhsCommand,
    content: parsed.values.content,
    contentFile: parsed.values["content-file"],
    headless: parsed.values.headless ?? false,
    imageUrls: parsed.values["image-url"] ?? [],
    images: parsed.values.image ?? [],
    mode,
    title: parsed.values.title,
    titleFile: parsed.values["title-file"],
  };
}

export function collectCleanupTitles(
  inlineTitles: string[],
  reportPayloads: Array<{ livePublishTitle?: string }>,
): string[] {
  const titles = new Set(
    inlineTitles.map((title) => title.trim()).filter((title) => title.length > 0),
  );
  for (const report of reportPayloads) {
    const title = report.livePublishTitle?.trim();
    if (title) {
      titles.add(title);
    }
  }
  return [...titles];
}

async function resolveCleanupTitles(options: ParsedCommand): Promise<string[]> {
  const reportPayloads = await Promise.all(
    options.cleanupReportFiles.map(async (reportFile) => {
      const raw = await readFile(reportFile, "utf8");
      return JSON.parse(raw) as { livePublishTitle?: string };
    }),
  );
  const titles = collectCleanupTitles(options.cleanupTitles, reportPayloads);
  if (titles.length === 0) {
    throw new Error(
      "cleanup-published requires at least one --cleanup-title or --report-file with livePublishTitle.",
    );
  }
  return titles;
}

async function resolveTextInput(
  inlineValue: string | undefined,
  filePath: string | undefined,
  label: "content" | "title",
): Promise<string> {
  if (inlineValue && filePath) {
    throw new Error(`Use either --${label} or --${label}-file, not both.`);
  }

  const resolved = filePath ? (await readFile(filePath, "utf8")).trim() : inlineValue?.trim();
  if (!resolved) {
    throw new Error(`Missing required ${label}. Pass --${label} or --${label}-file.`);
  }
  return resolved;
}

async function resolveFillRequest(options: ParsedCommand): Promise<ResolvedFillRequest> {
  if (options.images.length > 0 && options.imageUrls.length > 0) {
    throw new Error("Use either --image or --image-url, not both.");
  }

  const title = await resolveTextInput(options.title, options.titleFile, "title");
  const content = await resolveTextInput(options.content, options.contentFile, "content");

  if (options.images.length === 0 && options.imageUrls.length === 0) {
    throw new Error("fill/draft/publish requires at least one --image or --image-url.");
  }

  let downloaded: DownloadedImages | undefined;
  const imagePaths =
    options.images.length > 0
      ? options.images
      : ((downloaded = await downloadImageUrls(options.imageUrls)), downloaded.paths);

  if (imagePaths.length === 0) {
    throw new Error("No Xiaohongshu images are available to upload.");
  }

  for (const imagePath of imagePaths) {
    if (!existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }
  }

  return {
    cleanup: async () => {
      await downloaded?.cleanup();
    },
    request: {
      content,
      imagePaths,
      title,
    },
  };
}

async function openLoggedInPublisher(options: ParsedCommand) {
  const bridge = new XhsBridge({ account: options.account, headless: options.headless });
  const publisher = await bridge.openCreatorPublisher();
  const loggedIn = await publisher.checkLogin();
  if (loggedIn) {
    return publisher;
  }

  publisher.close();
  if (options.headless) {
    const headedBridge = new XhsBridge({ account: options.account, headless: false });
    await headedBridge.restartChrome();
    const headedPublisher = await headedBridge.openCreatorPublisher();
    try {
      await headedPublisher.openLoginPage();
    } finally {
      headedPublisher.close();
    }
  }

  throw new NotLoggedInError();
}

async function emitAuditArtifacts(
  command: Extract<XhsCommand, "draft" | "fill" | "publish">,
  options: ParsedCommand,
  request: FillImageTextRequest,
  snapshot: PublisherAuditSnapshot | undefined,
): Promise<void> {
  if (!snapshot) {
    return;
  }

  try {
    const summary = await writeAuditArtifacts(
      {
        auditDir: options.auditDir,
        command,
        content: request.content,
        imagePaths: request.imagePaths,
        title: request.title,
      },
      snapshot,
    );

    console.log(`XHS_AUDIT_DIR: ${summary.auditDir}`);
    console.log(`XHS_AUDIT_SUMMARY: ${JSON.stringify(summary)}`);
  } catch (error) {
    console.warn(`XHS_AUDIT_WARNING: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function captureAuditSnapshot(
  publisher: Awaited<ReturnType<typeof openLoggedInPublisher>>,
): Promise<PublisherAuditSnapshot | undefined> {
  try {
    return await publisher.captureAuditSnapshot();
  } catch (error) {
    console.warn(`XHS_AUDIT_WARNING: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function runXhsCli(argv: string[]): Promise<number> {
  const options = parseCommand(argv);

  try {
    switch (options.command) {
      case "check-login": {
        const bridge = new XhsBridge({ account: options.account, headless: options.headless });
        const publisher = await bridge.openCreatorPublisher();
        try {
          const loggedIn = await publisher.checkLogin();
          if (!loggedIn) {
            console.log("NOT_LOGGED_IN");
            return 1;
          }
          console.log("LOGIN_CONFIRMED");
          return 0;
        } finally {
          publisher.close();
        }
      }
      case "login": {
        const bridge = new XhsBridge({ account: options.account, headless: false });
        await bridge.restartChrome();
        const publisher = await bridge.openCreatorPublisher();
        try {
          await publisher.openLoginPage();
          console.log("LOGIN_READY");
          return 0;
        } finally {
          publisher.close();
        }
      }
      case "click-publish": {
        const bridge = new XhsBridge({ account: options.account, headless: options.headless });
        const publisher = await bridge.openComposePublisher("publish");
        try {
          await publisher.clickPublish();
          console.log("PUBLISH_STATUS: PUBLISHED");
          return 0;
        } finally {
          publisher.close();
        }
      }
      case "cleanup-published": {
        const titles = await resolveCleanupTitles(options);
        const publisher = await openLoggedInPublisher(options);
        try {
          const summary = await publisher.cleanupPublishedNotes({
            apply: options.apply,
            titles,
          });
          console.log(`CLEANUP_MODE: ${options.apply ? "APPLY" : "DRY_RUN"}`);
          console.log(`CLEANUP_SUMMARY: ${JSON.stringify(summary)}`);
          return 0;
        } finally {
          publisher.close();
        }
      }
      case "save-draft": {
        const bridge = new XhsBridge({ account: options.account, headless: options.headless });
        const publisher = await bridge.openComposePublisher("save", options.title);
        try {
          await publisher.saveDraft();
          console.log("DRAFT_STATUS: SAVED");
          return 0;
        } finally {
          publisher.close();
        }
      }
      case "fill":
      case "draft":
      case "publish": {
        const resolved = await resolveFillRequest(options);
        try {
          const publisher = await openLoggedInPublisher(options);
          try {
            await publisher.fillImageText(resolved.request);
            console.log("FILL_STATUS: READY_TO_PUBLISH");
            const auditSnapshot = await captureAuditSnapshot(publisher);
            if (options.command === "draft") {
              await publisher.saveDraft();
              console.log("DRAFT_STATUS: SAVED");
            }
            if (options.command === "publish") {
              await publisher.clickPublish();
              console.log("PUBLISH_STATUS: PUBLISHED");
            }
            await emitAuditArtifacts(options.command, options, resolved.request, auditSnapshot);
            return 0;
          } finally {
            publisher.close();
          }
        } finally {
          await resolved.cleanup();
        }
      }
      default:
        return unreachable(options.command);
    }
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      console.log("NOT_LOGGED_IN");
      return 1;
    }
    throw error;
  }
}

function unreachable(value: never): never {
  throw new Error(`Unsupported command: ${String(value)}`);
}
