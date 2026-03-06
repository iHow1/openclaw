import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Command =
  | "check-login"
  | "login"
  | "fill"
  | "draft"
  | "publish"
  | "click-publish"
  | "save-draft";

interface ResolvedOptions {
  root: string;
  scriptsDir: string;
  command: Command;
  account?: string;
  headless: boolean;
  mode: "image-text" | "long-article";
  title?: string;
  content?: string;
  titleFile?: string;
  contentFile?: string;
  images: string[];
  imageUrls: string[];
}

const DEFAULT_DEBUG_PORT = Number(process.env.OPENCLAW_XHS_DEBUG_PORT ?? "9222");

function usage(): string {
  return [
    "Usage:",
    "  pnpm xhs -- check-login",
    "  pnpm xhs -- login",
    '  pnpm xhs -- fill --title "标题" --content "正文" --image /abs/path.png',
    '  pnpm xhs -- draft --title "标题" --content "正文" --image /abs/path.png',
    "  pnpm xhs -- publish --title-file title.txt --content-file body.txt --image /abs/path.png",
    '  pnpm xhs -- save-draft [--title "标题"]',
    "  pnpm xhs -- click-publish",
    "",
    "Options:",
    "  --root <dir>          Override xiaohongshu-mcp root (default: XHS_MCP_ROOT or ../xiaohongshu-mcp)",
    "  --account <name>      Upstream account name",
    "  --headless            Run upstream Chrome in headless mode",
    "  --mode <mode>         image-text (default) or long-article",
    "  --title <text>        Title text",
    "  --content <text>      Content text",
    "  --title-file <path>   Title file path",
    "  --content-file <path> Content file path",
    "  --image <path>        Local image path (repeatable)",
    "  --image-url <url>     Remote image URL (repeatable)",
  ].join("\n");
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultChromePath(): string {
  const override = process.env.OPENCLAW_XHS_CHROME_BIN;
  if (override) {
    return override;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

function defaultProfileDir(): string {
  return (
    process.env.OPENCLAW_XHS_PROFILE_DIR ?? path.join(os.homedir(), ".codex", "chrome-mcp-profile")
  );
}

function resolveXhsRoot(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.XHS_MCP_ROOT,
    path.resolve(repoRoot(), "..", "xiaohongshu-mcp"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      existsSync(path.join(resolved, "skills", "post-to-xhs", "scripts", "publish_pipeline.py"))
    ) {
      return resolved;
    }
  }

  throw new Error(
    [
      "Unable to locate xiaohongshu-mcp.",
      "Set XHS_MCP_ROOT or pass --root <dir>.",
      `Tried default sibling path: ${path.resolve(repoRoot(), "..", "xiaohongshu-mcp")}`,
    ].join(" "),
  );
}

function parseCommand(argv: string[]): ResolvedOptions {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [commandRaw, ...rest] = normalizedArgv;
  const command = commandRaw as Command | undefined;
  if (
    !command ||
    !["check-login", "login", "fill", "draft", "publish", "click-publish", "save-draft"].includes(
      command,
    )
  ) {
    throw new Error(usage());
  }

  const parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    strict: true,
    options: {
      root: { type: "string" },
      account: { type: "string" },
      headless: { type: "boolean", default: false },
      mode: { type: "string", default: "image-text" },
      title: { type: "string" },
      content: { type: "string" },
      "title-file": { type: "string" },
      "content-file": { type: "string" },
      image: { type: "string", multiple: true, default: [] },
      "image-url": { type: "string", multiple: true, default: [] },
    },
  });

  const mode = parsed.values.mode;
  if (mode !== "image-text" && mode !== "long-article") {
    throw new Error(`Unsupported --mode: ${mode}`);
  }

  const root = resolveXhsRoot(parsed.values.root);
  return {
    root,
    scriptsDir: path.join(root, "skills", "post-to-xhs", "scripts"),
    command,
    account: parsed.values.account,
    headless: parsed.values.headless ?? false,
    mode,
    title: parsed.values.title,
    content: parsed.values.content,
    titleFile: parsed.values["title-file"],
    contentFile: parsed.values["content-file"],
    images: parsed.values.image ?? [],
    imageUrls: parsed.values["image-url"] ?? [],
  };
}

function buildBaseArgs(opts: ResolvedOptions): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("--account", opts.account);
  }
  if (opts.headless) {
    args.push("--headless");
  }
  return args;
}

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number, timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface CdpPageTarget {
  url?: string;
  webSocketDebuggerUrl: string;
}

async function listCdpPageTargets(targetUrlIncludes?: string): Promise<CdpPageTarget[]> {
  const targets = (await fetch(`http://127.0.0.1:${DEFAULT_DEBUG_PORT}/json`).then((res) =>
    res.json(),
  )) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;

  return targets
    .filter(
      (item): item is CdpPageTarget & { type: string } =>
        item.type === "page" &&
        typeof item.webSocketDebuggerUrl === "string" &&
        (!targetUrlIncludes || String(item.url ?? "").includes(targetUrlIncludes)),
    )
    .map((item) => ({
      url: item.url,
      webSocketDebuggerUrl: item.webSocketDebuggerUrl,
    }));
}

async function openCdpSession(webSocketDebuggerUrl: string): Promise<CdpSession> {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      (event) => reject(new Error(`CDP websocket open failed: ${String(event.type)}`)),
      { once: true },
    );
  });

  let nextId = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof data.id !== "number" || !pending.has(data.id)) {
      return;
    }
    const entry = pending.get(data.id);
    pending.delete(data.id);
    if (!entry) {
      return;
    }
    if (data.error) {
      entry.reject(new Error(data.error.message ?? JSON.stringify(data.error)));
      return;
    }
    entry.resolve(data.result);
  });

  const send = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {
        resolve,
        reject: (error) => reject(error),
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  return { send, close: () => ws.close() };
}

interface DraftProbe {
  href: string;
  hasSave: boolean;
  bodyPreview: string;
  hasExpectedTitle: boolean;
}

async function probeDraftPage(session: CdpSession, expectedTitle?: string): Promise<DraftProbe> {
  const titleJson = JSON.stringify(expectedTitle ?? "");
  return await runtimeValue<DraftProbe>(
    session,
    `(() => {
      const title = ${titleJson};
      const body = document.body.innerText || '';
      const hasSave = !!(
        document.querySelector('.publish-page-publish-btn button.custom-button.white') ||
        Array.from(document.querySelectorAll('button')).find((el) =>
          (el.innerText || '').includes('暂存离开'),
        )
      );
      return {
        href: window.location.href,
        hasSave,
        bodyPreview: body.slice(0, 600),
        hasExpectedTitle: !!title && body.includes(title),
      };
    })()`,
  );
}

async function pickDraftSession(expectedTitle?: string): Promise<CdpSession> {
  const targets = await listCdpPageTargets("/publish/");
  if (targets.length === 0) {
    throw new Error("No Chrome publish page target available on the XHS bridge port.");
  }

  const sessions: Array<{ session: CdpSession; probe: DraftProbe }> = [];
  try {
    for (const target of targets) {
      const session = await openCdpSession(target.webSocketDebuggerUrl);
      const probe = await probeDraftPage(session, expectedTitle);
      if (probe.hasSave) {
        sessions.push({ session, probe });
        continue;
      }
      session.close();
    }

    if (sessions.length === 0) {
      throw new Error("No editable Xiaohongshu compose page is open.");
    }

    const selected =
      (expectedTitle ? sessions.find((item) => item.probe.hasExpectedTitle) : undefined) ??
      (sessions.length === 1 ? sessions[0] : undefined);

    if (!selected) {
      throw new Error(
        expectedTitle
          ? `Multiple compose pages are open, but none matched title: ${expectedTitle}`
          : "Multiple editable compose pages are open. Pass --title to save the intended draft or close extra compose tabs.",
      );
    }

    for (const entry of sessions) {
      if (entry !== selected) {
        entry.session.close();
      }
    }
    return selected.session;
  } catch (error) {
    for (const entry of sessions) {
      entry.session.close();
    }
    throw error;
  }
}

async function runtimeValue<T>(session: CdpSession, expression: string): Promise<T> {
  const result = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T } };
  return result.result?.value as T;
}

async function saveDraftViaCdp(expectedTitle?: string): Promise<void> {
  const session = await pickDraftSession(expectedTitle);
  try {
    const clicked = await runtimeValue<{ ok: boolean; reason?: string }>(
      session,
      `(() => {
        const btn =
          document.querySelector('.publish-page-publish-btn button.custom-button.white') ||
          Array.from(document.querySelectorAll('button')).find((el) =>
            (el.innerText || '').includes('暂存离开'),
          );
        if (!btn) return { ok: false, reason: 'save draft button not found' };
        btn.click();
        return { ok: true };
      })()`,
    );
    if (!clicked?.ok) {
      throw new Error(clicked?.reason ?? "Failed to click save draft button.");
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await runtimeValue<{ href: string; body: string }>(
        session,
        `(() => ({
          href: window.location.href,
          body: document.body.innerText.slice(0, 2000),
        }))()`,
      );
      if (
        state?.body?.includes("草稿箱") ||
        state?.href?.includes("published=true") ||
        !state?.href?.includes("/publish/publish?from=tab_switch")
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      "Timed out waiting for Xiaohongshu to leave the compose page after saving draft.",
    );
  } finally {
    session.close();
  }
}

async function ensureBridgeChrome(headless: boolean): Promise<void> {
  if (await isPortOpen(DEFAULT_DEBUG_PORT)) {
    return;
  }

  const chromePath = defaultChromePath();
  const profileDir = defaultProfileDir();
  const args = [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${DEFAULT_DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://creator.xiaohongshu.com/new/home",
  ];
  if (headless) {
    args.unshift("--headless=new");
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const ready = await waitForPort(DEFAULT_DEBUG_PORT);
  if (!ready) {
    throw new Error(
      `Chrome did not expose remote debugging on port ${DEFAULT_DEBUG_PORT}. ` +
        `Expected profile: ${profileDir}`,
    );
  }
}

async function withTempTextFile(
  prefix: string,
  content: string,
): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `openclaw-xhs-${prefix}-`));
  const file = path.join(dir, `${prefix}.txt`);
  await writeFile(file, content, "utf8");
  return { dir, file };
}

async function buildFillArgs(
  opts: ResolvedOptions,
): Promise<{ args: string[]; cleanupDirs: string[]; titleText: string }> {
  const cleanupDirs: string[] = [];
  let titleFile = opts.titleFile;
  let contentFile = opts.contentFile;
  let titleText = opts.title;

  if (!titleFile) {
    if (!opts.title) {
      throw new Error("fill/publish requires --title or --title-file");
    }
    const temp = await withTempTextFile("title", opts.title);
    cleanupDirs.push(temp.dir);
    titleFile = temp.file;
  } else if (!titleText) {
    titleText = (await readFile(titleFile, "utf8")).trim();
  }

  if (!contentFile) {
    if (!opts.content) {
      throw new Error("fill/publish requires --content or --content-file");
    }
    const temp = await withTempTextFile("content", opts.content);
    cleanupDirs.push(temp.dir);
    contentFile = temp.file;
  }

  if (opts.mode === "image-text" && opts.images.length === 0 && opts.imageUrls.length === 0) {
    throw new Error("image-text mode requires at least one --image or --image-url");
  }

  const args = [
    "publish_pipeline.py",
    ...buildBaseArgs(opts),
    "--mode",
    opts.mode,
    "--title-file",
    titleFile,
    "--content-file",
    contentFile,
  ];

  if (opts.images.length > 0) {
    args.push("--images", ...opts.images);
  } else if (opts.imageUrls.length > 0) {
    args.push("--image-urls", ...opts.imageUrls);
  }

  if (opts.command === "publish") {
    args.push("--auto-publish");
  }

  return { args, cleanupDirs, titleText };
}

function spawnPython(scriptsDir: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd: scriptsDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`python3 exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function run(argv: string[]): Promise<number> {
  const opts = parseCommand(argv);
  const cleanupDirs: string[] = [];

  try {
    await ensureBridgeChrome(opts.headless);
    switch (opts.command) {
      case "check-login":
        return await spawnPython(opts.scriptsDir, [
          "cdp_publish.py",
          ...buildBaseArgs(opts),
          "check-login",
        ]);
      case "login":
        return await spawnPython(opts.scriptsDir, [
          "cdp_publish.py",
          ...buildBaseArgs(opts),
          "login",
        ]);
      case "click-publish":
        return await spawnPython(opts.scriptsDir, [
          "cdp_publish.py",
          ...buildBaseArgs(opts),
          "click-publish",
        ]);
      case "save-draft":
        await saveDraftViaCdp(opts.title);
        return 0;
      case "fill":
      case "draft":
      case "publish": {
        const built = await buildFillArgs(opts);
        cleanupDirs.push(...built.cleanupDirs);
        const code = await spawnPython(opts.scriptsDir, built.args);
        if (code !== 0) {
          return code;
        }
        if (opts.command === "draft") {
          await saveDraftViaCdp(built.titleText);
        }
        return 0;
      }
      default:
        return unreachable(opts.command);
    }
  } finally {
    await Promise.all(cleanupDirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
  }
}

function unreachable(value: never): never {
  throw new Error(`Unsupported command: ${String(value)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
