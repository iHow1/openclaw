import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface BridgeChromeOptions {
  account?: string;
  headless: boolean;
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface CdpPageTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface ComposePageProbe {
  bodyPreview: string;
  hasExpectedTitle: boolean;
  hasPublish: boolean;
  hasSave: boolean;
  href: string;
}

interface ComposePageEntry {
  probe: ComposePageProbe;
  session: CdpSession;
}

export type ComposeAction = "publish" | "save";

const DEFAULT_DEBUG_PORT = Number(process.env.OPENCLAW_XHS_DEBUG_PORT ?? "9222");

const CREATOR_ORIGIN = "https://creator.xiaohongshu.com";
const XHS_CREATOR_HOME_URL = `${CREATOR_ORIGIN}/new/home`;
const XHS_LOGIN_CHECK_URL = CREATOR_ORIGIN;
const XHS_LOGIN_URL = `${CREATOR_ORIGIN}/login`;
const XHS_NOTE_MANAGER_URL = `${CREATOR_ORIGIN}/new/note-manager`;
const XHS_PUBLISH_URL = `${CREATOR_ORIGIN}/publish/publish`;

const PAGE_LOAD_WAIT_MS = 3_000;
const TAB_CLICK_WAIT_MS = 2_000;
const UPLOAD_WAIT_MS = 6_000;
const ACTION_INTERVAL_MS = 1_000;
const AUDIT_CAPTURE_TIMEOUT_MS = 5_000;
const NOTE_MANAGER_SCROLL_WAIT_MS = 1_500;
const NOTE_MANAGER_SCAN_LIMIT = 12;

const IMAGE_TEXT_TAB_LABELS = ["上传图文"];
const PUBLISH_BUTTON_LABELS = ["发布", "立即发布"];
const SAVE_DRAFT_BUTTON_LABELS = ["暂存离开", "保存草稿", "保存到草稿"];
const SUCCESS_TEXT_MARKERS = ["草稿箱", "保存成功", "发布成功"];

const CONTENT_EDITOR_SELECTORS = [
  "div.tiptap.ProseMirror",
  "div.ProseMirror[contenteditable='true']",
  "[contenteditable='true'][data-placeholder*='输入正文']",
  "[contenteditable='true'][class*='editor']",
];

const IMAGE_TEXT_TAB_SELECTORS = [
  "div.creator-tab",
  "[role='tab']",
  "[class*='creator-tab']",
  "[class*='tab']",
];

const LOGIN_INDICATOR_SELECTORS = [
  ".user-info",
  ".creator-header",
  "[class*='user']",
  "[class*='avatar']",
  "[class*='creator-header']",
];

const TITLE_INPUT_SELECTORS = [
  "input[placeholder*='填写标题']",
  "input[placeholder*='标题']",
  "textarea[placeholder*='标题']",
  "input.d-text",
];

const UPLOAD_INPUT_SELECTORS = [
  "input.upload-input",
  "input[type='file'][accept*='image']",
  "input[type='file']",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out while ${label} after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function domHelpersExpression(): string {
  return `
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const matchesAnyLabel = (text, labels) => labels.some((label) => normalizeText(text) === label);
    const selectFirst = (selectors) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    };
    const findActionButton = (labels) => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], .d-button, [class*="btn"], [class*="button"]'),
      );
      return candidates.find((candidate) => matchesAnyLabel(candidate.textContent, labels)) || null;
    };
    const findElementByText = (selectors, labels) => {
      for (const selector of selectors) {
        const candidates = Array.from(document.querySelectorAll(selector));
        const matched = candidates.find((candidate) => matchesAnyLabel(candidate.textContent, labels));
        if (matched) return matched;
      }
      return null;
    };
  `;
}

function portUrl(pathname: string): string {
  return `http://127.0.0.1:${DEFAULT_DEBUG_PORT}${pathname}`;
}

function sanitizeAccountName(account: string): string {
  return account.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "default";
}

function findExecutableInPath(names: string[]): string | undefined {
  const searchPaths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const base of searchPaths) {
    for (const name of names) {
      const candidate = path.join(base, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveChromePath(): string {
  const override = process.env.OPENCLAW_XHS_CHROME_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`OPENCLAW_XHS_CHROME_BIN does not exist: ${override}`);
    }
    return override;
  }

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(
            os.homedir(),
            "Applications",
            "Google Chrome.app",
            "Contents",
            "MacOS",
            "Google Chrome",
          ),
        ]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.PROGRAMFILES ?? "",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            path.join(
              process.env["PROGRAMFILES(X86)"] ?? "",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
          ].filter(Boolean)
        : [];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const pathMatch = findExecutableInPath(
    process.platform === "win32"
      ? ["chrome.exe", "chrome"]
      : ["google-chrome", "Google Chrome", "chromium", "chrome"],
  );
  if (pathMatch) {
    return pathMatch;
  }

  throw new Error("Chrome not found. Set OPENCLAW_XHS_CHROME_BIN to a valid Chrome executable.");
}

export function resolveChromeProfileDir(account?: string): string {
  if (account) {
    const base =
      process.env.OPENCLAW_XHS_PROFILE_BASE ?? path.join(os.homedir(), ".openclaw", "xhs-profiles");
    return path.join(base, sanitizeAccountName(account));
  }

  return (
    process.env.OPENCLAW_XHS_PROFILE_DIR ?? path.join(os.homedir(), ".codex", "chrome-mcp-profile")
  );
}

export async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(
  port: number,
  timeoutMs: number,
  expectedOpen: boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(port)) === expectedOpen) {
      return true;
    }
    await delay(500);
  }
  return false;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

async function listPageTargets(): Promise<
  Array<Required<Pick<CdpPageTarget, "type" | "webSocketDebuggerUrl">> & Pick<CdpPageTarget, "url">>
> {
  const targets = await fetchJson<CdpPageTarget[]>(portUrl("/json"));
  return targets.filter(
    (
      target,
    ): target is Required<Pick<CdpPageTarget, "type" | "webSocketDebuggerUrl">> &
      Pick<CdpPageTarget, "url"> =>
      target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
  );
}

export async function countPageTargetsByPrefix(prefix: string): Promise<number> {
  const targets = await listPageTargets();
  return targets.filter((target) => String(target.url ?? "").startsWith(prefix)).length;
}

async function openNewPageTarget(url: string): Promise<string> {
  const target = await fetchJson<CdpPageTarget>(portUrl(`/json/new?${url}`), { method: "PUT" });
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Chrome did not return a debugger target for ${url}`);
  }
  return target.webSocketDebuggerUrl;
}

function rejectPendingRequests(
  pending: Map<number, { reject(error: Error): void; resolve(value: unknown): void }>,
  error: Error,
): void {
  for (const [, request] of pending) {
    request.reject(error);
  }
  pending.clear();
}

async function openCdpSession(webSocketDebuggerUrl: string): Promise<CdpSession> {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error(`Failed to connect to ${webSocketDebuggerUrl}`)),
      {
        once: true,
      },
    );
  });

  let nextId = 1;
  const pending = new Map<number, { reject(error: Error): void; resolve(value: unknown): void }>();

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data)) as {
      error?: { message?: string };
      id?: number;
      result?: unknown;
    };
    if (typeof payload.id !== "number") {
      return;
    }
    const entry = pending.get(payload.id);
    if (!entry) {
      return;
    }
    pending.delete(payload.id);
    if (payload.error) {
      entry.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
      return;
    }
    entry.resolve(payload.result);
  });

  ws.addEventListener("close", () => {
    rejectPendingRequests(pending, new Error("CDP websocket closed"));
  });
  ws.addEventListener("error", () => {
    rejectPendingRequests(pending, new Error("CDP websocket error"));
  });

  const send = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    await new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  return {
    close: () => ws.close(),
    send,
  };
}

async function browserLevelSession(): Promise<CdpSession | undefined> {
  if (!(await isPortOpen(DEFAULT_DEBUG_PORT))) {
    return undefined;
  }
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(portUrl("/json/version"));
  if (!version.webSocketDebuggerUrl) {
    return undefined;
  }
  return await openCdpSession(version.webSocketDebuggerUrl);
}

async function closeChromeViaCdp(): Promise<void> {
  const session = await browserLevelSession();
  if (!session) {
    return;
  }

  try {
    await session.send("Browser.close");
  } catch {
    // Chrome may close the socket before acknowledging Browser.close.
  } finally {
    session.close();
  }
}

export async function ensureBridgeChrome(options: BridgeChromeOptions): Promise<void> {
  if (await isPortOpen(DEFAULT_DEBUG_PORT)) {
    return;
  }

  const profileDir = resolveChromeProfileDir(options.account);
  await mkdir(profileDir, { recursive: true });

  const args = [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${DEFAULT_DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    XHS_CREATOR_HOME_URL,
  ];
  if (options.headless) {
    args.unshift("--headless=new");
  }

  const child = spawn(resolveChromePath(), args, {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForPort(DEFAULT_DEBUG_PORT, 15_000, true);
  if (!ready) {
    throw new Error(
      `Chrome did not expose remote debugging on port ${DEFAULT_DEBUG_PORT}. Expected profile: ${profileDir}`,
    );
  }
}

export async function restartBridgeChrome(options: BridgeChromeOptions): Promise<void> {
  await closeChromeViaCdp();
  const closed = await waitForPort(DEFAULT_DEBUG_PORT, 5_000, false);
  if (!closed && (await isPortOpen(DEFAULT_DEBUG_PORT))) {
    throw new Error(
      `Could not restart Chrome on port ${DEFAULT_DEBUG_PORT} because the existing bridge instance did not exit.`,
    );
  }
  await ensureBridgeChrome(options);
}

async function openCreatorSession(): Promise<CdpSession> {
  const targets = await listPageTargets();
  const existing = targets.find((target) =>
    String(target.url ?? "").startsWith(XHS_LOGIN_CHECK_URL),
  );
  if (existing) {
    return await openCdpSession(existing.webSocketDebuggerUrl);
  }
  return await openCdpSession(await openNewPageTarget(XHS_CREATOR_HOME_URL));
}

async function runtimeValue<T>(session: CdpSession, expression: string): Promise<T> {
  const result = (await session.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  })) as {
    exceptionDetails?: { text?: string };
    result?: { description?: string; subtype?: string; value?: T };
  };

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "CDP runtime evaluation failed");
  }

  if (result.result?.subtype === "error") {
    throw new Error(result.result.description ?? "CDP runtime evaluation returned an error");
  }

  return result.result?.value as T;
}

async function probeComposePage(
  session: CdpSession,
  expectedTitle?: string,
): Promise<ComposePageProbe> {
  const titleJson = JSON.stringify(expectedTitle ?? "");
  return await runtimeValue<ComposePageProbe>(
    session,
    `(() => {
      ${domHelpersExpression()}
      const title = ${titleJson};
      const hasSave = !!findActionButton(${JSON.stringify(SAVE_DRAFT_BUTTON_LABELS)});
      const hasPublish = !!findActionButton(${JSON.stringify(PUBLISH_BUTTON_LABELS)});
      const body = document.body.innerText || '';
      return {
        href: window.location.href,
        hasSave,
        hasPublish,
        bodyPreview: body.slice(0, 600),
        hasExpectedTitle: !!title && body.includes(title),
      };
    })()`,
  );
}

export function selectComposeCandidate(
  entries: ComposePageProbe[],
  action: ComposeAction,
  expectedTitle?: string,
): number {
  const actionableIndexes = entries
    .map((probe, index) => ({
      index,
      isActionable: action === "save" ? probe.hasSave : probe.hasPublish,
    }))
    .filter((entry) => entry.isActionable)
    .map((entry) => entry.index);

  if (actionableIndexes.length === 0) {
    throw new Error(
      action === "save"
        ? "No editable Xiaohongshu compose page is open."
        : "No publish-ready Xiaohongshu compose page is open.",
    );
  }

  if (expectedTitle) {
    const matchedIndexes = actionableIndexes.filter((index) => entries[index]?.hasExpectedTitle);
    if (matchedIndexes.length === 1) {
      return matchedIndexes[0];
    }
    if (matchedIndexes.length > 1) {
      throw new Error(`Multiple compose pages matched title: ${expectedTitle}`);
    }
    throw new Error(`Multiple compose pages are open, but none matched title: ${expectedTitle}`);
  }

  if (actionableIndexes.length === 1) {
    return actionableIndexes[0];
  }

  throw new Error(
    action === "save"
      ? "Multiple editable compose pages are open. Pass --title to save the intended draft or close extra compose tabs."
      : "Multiple publish-ready compose pages are open. Close extra compose tabs before running click-publish.",
  );
}

async function openComposeSession(
  action: ComposeAction,
  expectedTitle?: string,
): Promise<CdpSession> {
  const targets = await listPageTargets();
  const composeTargets = targets.filter((target) => String(target.url ?? "").includes("/publish/"));
  if (composeTargets.length === 0) {
    throw new Error("No Chrome publish page target is available on the XHS bridge port.");
  }

  const entries: ComposePageEntry[] = [];
  try {
    for (const target of composeTargets) {
      let session: CdpSession | undefined;
      try {
        session = await openCdpSession(target.webSocketDebuggerUrl);
        const probe = await probeComposePage(session, expectedTitle);
        if ((action === "save" && probe.hasSave) || (action === "publish" && probe.hasPublish)) {
          entries.push({ probe, session });
          continue;
        }
      } catch {
        // Ignore non-compose tabs under the publish URL umbrella.
      }
      session?.close();
    }

    const selectedIndex = selectComposeCandidate(
      entries.map((entry) => entry.probe),
      action,
      expectedTitle,
    );
    const selectedEntry = entries[selectedIndex];
    if (!selectedEntry) {
      throw new Error("Internal compose page selection failed.");
    }

    for (const entry of entries) {
      if (entry !== selectedEntry) {
        entry.session.close();
      }
    }
    return selectedEntry.session;
  } catch (error) {
    for (const entry of entries) {
      entry.session.close();
    }
    throw error;
  }
}

async function navigate(session: CdpSession, url: string): Promise<void> {
  await session.send("Page.enable");
  await session.send("Page.navigate", { url });
  await delay(PAGE_LOAD_WAIT_MS);
}

export interface FillImageTextRequest {
  content: string;
  imagePaths: string[];
  title: string;
}

export interface PublisherAuditSnapshot {
  bodyPreview: string;
  hasPublish: boolean;
  hasSave: boolean;
  href: string;
  screenshotBase64: string;
}

export interface PublishedNoteEntry {
  noteId?: string;
  publishedAt?: string;
  title: string;
  visibility?: string;
}

export interface PublishedNoteCleanupRequest {
  apply: boolean;
  maxScrolls?: number;
  titles: string[];
}

export interface PublishedNoteCleanupResult extends PublishedNoteEntry {
  requestedTitle: string;
  status: "ambiguous" | "deleted" | "not_found" | "would_delete";
}

export interface PublishedNoteCleanupSummary {
  deletedCount: number;
  results: PublishedNoteCleanupResult[];
}

export class XhsPublisher {
  constructor(private readonly session: CdpSession) {}

  close(): void {
    this.session.close();
  }

  async checkLogin(): Promise<boolean> {
    await navigate(this.session, XHS_LOGIN_CHECK_URL);
    await delay(2_000);

    const currentUrl = await this.evaluate<string>("window.location.href");
    if (currentUrl.toLowerCase().includes("login")) {
      return false;
    }

    return await this.evaluate<boolean>(`
      (() => {
        ${domHelpersExpression()}
        return !!selectFirst(${JSON.stringify(LOGIN_INDICATOR_SELECTORS)}) || window.location.href.startsWith(${JSON.stringify(XHS_LOGIN_CHECK_URL)});
      })()
    `);
  }

  async openLoginPage(): Promise<void> {
    await navigate(this.session, XHS_LOGIN_CHECK_URL);
    await delay(2_000);
    const currentUrl = await this.evaluate<string>("window.location.href");
    if (!currentUrl.toLowerCase().includes("login")) {
      await navigate(this.session, XHS_LOGIN_URL);
      await delay(2_000);
    }
  }

  async fillImageText(request: FillImageTextRequest): Promise<void> {
    if (request.imagePaths.length === 0) {
      throw new Error("At least one image is required to publish on Xiaohongshu.");
    }

    await navigate(this.session, XHS_PUBLISH_URL);
    await delay(2_000);
    await this.clickImageTextTab();
    await this.uploadImages(request.imagePaths);
    await this.fillTitle(request.title);
    await this.fillContent(request.content);
  }

  async clickPublish(): Promise<void> {
    await delay(ACTION_INTERVAL_MS);
    const clicked = await this.evaluate<boolean>(`
      (() => {
        ${domHelpersExpression()}
        const button = findActionButton(${JSON.stringify(PUBLISH_BUTTON_LABELS)});
        if (!button) return false;
        button.click();
        return true;
      })()
    `);
    if (!clicked) {
      throw new Error("Could not find publish button. Please click it manually in the browser.");
    }
  }

  async saveDraft(): Promise<void> {
    const clicked = await this.evaluate<{ ok: boolean; reason?: string }>(`
      (() => {
        ${domHelpersExpression()}
        const button =
          document.querySelector('.publish-page-publish-btn button.custom-button.white') ||
          findActionButton(${JSON.stringify(SAVE_DRAFT_BUTTON_LABELS)});
        if (!button) return { ok: false, reason: 'save draft button not found' };
        button.click();
        return { ok: true };
      })()
    `);

    if (!clicked.ok) {
      throw new Error(clicked.reason ?? "Failed to click save draft button.");
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await this.evaluate<{ body: string; hasSave: boolean; href: string }>(`
        (() => {
          ${domHelpersExpression()}
          return {
            href: window.location.href,
            body: document.body.innerText.slice(0, 2000),
            hasSave: !!findActionButton(${JSON.stringify(SAVE_DRAFT_BUTTON_LABELS)}),
          };
        })()
      `);
      if (
        (!state.hasSave && SUCCESS_TEXT_MARKERS.some((marker) => state.body.includes(marker))) ||
        state.href.includes("published=true") ||
        (!state.hasSave && !state.href.includes("/publish/publish?from=tab_switch"))
      ) {
        return;
      }
      await delay(500);
    }

    throw new Error(
      "Timed out waiting for Xiaohongshu to leave the compose page after saving draft.",
    );
  }

  async captureAuditSnapshot(): Promise<PublisherAuditSnapshot> {
    const pageState = await withTimeout(
      this.evaluate<Omit<PublisherAuditSnapshot, "screenshotBase64">>(`
        (() => {
          ${domHelpersExpression()}
          return {
            href: window.location.href,
            bodyPreview: (document.body.innerText || '').slice(0, 1200),
            hasSave: !!findActionButton(${JSON.stringify(SAVE_DRAFT_BUTTON_LABELS)}),
            hasPublish: !!findActionButton(${JSON.stringify(PUBLISH_BUTTON_LABELS)}),
          };
        })()
      `),
      "capturing the Xiaohongshu page state",
      AUDIT_CAPTURE_TIMEOUT_MS,
    );
    const screenshot = await withTimeout(
      this.captureScreenshotBase64(),
      "capturing the Xiaohongshu preview screenshot",
      AUDIT_CAPTURE_TIMEOUT_MS,
    );

    return {
      ...pageState,
      screenshotBase64: screenshot,
    };
  }

  async cleanupPublishedNotes(
    request: PublishedNoteCleanupRequest,
  ): Promise<PublishedNoteCleanupSummary> {
    const results: PublishedNoteCleanupResult[] = [];
    const maxScrolls = request.maxScrolls ?? NOTE_MANAGER_SCAN_LIMIT;

    for (const requestedTitle of request.titles) {
      const normalizedTitle = requestedTitle.trim();
      if (!normalizedTitle) {
        continue;
      }

      const matches = await this.findPublishedNotesByTitle(normalizedTitle, maxScrolls);
      if (matches.length === 0) {
        results.push({
          requestedTitle: normalizedTitle,
          status: "not_found",
          title: normalizedTitle,
        });
        continue;
      }
      if (matches.length > 1) {
        results.push({
          requestedTitle: normalizedTitle,
          status: "ambiguous",
          title: normalizedTitle,
        });
        continue;
      }

      const match = matches[0];
      if (!request.apply) {
        results.push({
          ...match,
          requestedTitle: normalizedTitle,
          status: "would_delete",
        });
        continue;
      }

      await this.deletePublishedNoteByTitle(normalizedTitle);
      results.push({
        ...match,
        requestedTitle: normalizedTitle,
        status: "deleted",
      });
    }

    return {
      deletedCount: results.filter((result) => result.status === "deleted").length,
      results,
    };
  }

  private async clickImageTextTab(): Promise<void> {
    const clicked = await this.evaluate<boolean>(`
      (() => {
        ${domHelpersExpression()}
        const target = findElementByText(
          ${JSON.stringify(IMAGE_TEXT_TAB_SELECTORS)},
          ${JSON.stringify(IMAGE_TEXT_TAB_LABELS)},
        );
        if (!target) return false;
        target.click();
        return true;
      })()
    `);

    if (!clicked) {
      throw new Error("Could not find the '上传图文' tab. The page structure may have changed.");
    }

    await delay(TAB_CLICK_WAIT_MS);
  }

  private async uploadImages(imagePaths: string[]): Promise<void> {
    const normalizedPaths = imagePaths.map((imagePath) => imagePath.replaceAll("\\", "/"));
    await this.session.send("DOM.enable");
    const doc = (await this.session.send("DOM.getDocument")) as { root?: { nodeId?: number } };
    const rootId = doc.root?.nodeId;
    if (!rootId) {
      throw new Error("Could not access the publish page DOM.");
    }

    let inputNodeId: number | undefined;
    for (const selector of UPLOAD_INPUT_SELECTORS) {
      const query = (await this.session.send("DOM.querySelector", {
        nodeId: rootId,
        selector,
      })) as { nodeId?: number };
      if (query.nodeId) {
        inputNodeId = query.nodeId;
        break;
      }
    }
    if (!inputNodeId) {
      throw new Error("Could not find the Xiaohongshu image upload input.");
    }

    await this.session.send("DOM.setFileInputFiles", {
      files: normalizedPaths,
      nodeId: inputNodeId,
    });
    await delay(UPLOAD_WAIT_MS);
  }

  private async fillTitle(title: string): Promise<void> {
    await delay(ACTION_INTERVAL_MS);
    const found = await this.evaluate<boolean>(`
      (() => {
        ${domHelpersExpression()}
        return !!selectFirst(${JSON.stringify(TITLE_INPUT_SELECTORS)});
      })()
    `);
    if (!found) {
      throw new Error("Could not find the Xiaohongshu title input.");
    }

    await this.evaluate<void>(`
      (() => {
        ${domHelpersExpression()}
        const input = selectFirst(${JSON.stringify(TITLE_INPUT_SELECTORS)});
        if (!input) return;
        const prototype = input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        input.focus();
        setter?.call(input, ${JSON.stringify(title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  }

  private async fillContent(content: string): Promise<void> {
    await delay(ACTION_INTERVAL_MS);
    const found = await this.evaluate<boolean>(`
      (() => {
        ${domHelpersExpression()}
        return !!selectFirst(${JSON.stringify(CONTENT_EDITOR_SELECTORS)});
      })()
    `);
    if (!found) {
      throw new Error("Could not find the Xiaohongshu content editor.");
    }

    await this.evaluate<void>(`
      (() => {
        ${domHelpersExpression()}
        const editor = selectFirst(${JSON.stringify(CONTENT_EDITOR_SELECTORS)});
        if (!editor) return;
        const paragraphs = ${JSON.stringify(content)}.split('\\n').filter((part) => part.trim());
        editor.focus();
        editor.innerHTML = '';
        for (let i = 0; i < paragraphs.length; i++) {
          const paragraph = document.createElement('p');
          paragraph.textContent = paragraphs[i];
          editor.appendChild(paragraph);
          if (i < paragraphs.length - 1) {
            const spacer = document.createElement('p');
            spacer.appendChild(document.createElement('br'));
            editor.appendChild(spacer);
          }
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
  }

  private async evaluate<T>(expression: string): Promise<T> {
    return await runtimeValue<T>(this.session, expression);
  }

  private async findPublishedNotesByTitle(
    title: string,
    maxScrolls: number,
  ): Promise<PublishedNoteEntry[]> {
    await navigate(this.session, XHS_NOTE_MANAGER_URL);
    await delay(2_000);

    const seen = new Set<string>();
    for (let attempt = 0; attempt < maxScrolls; attempt += 1) {
      const entries = await this.readVisiblePublishedNotes();
      const matches = entries.filter((entry) => entry.title === title);
      if (matches.length > 0) {
        return matches;
      }

      const signature = entries
        .map((entry) => entry.noteId ?? `${entry.title}|${entry.publishedAt ?? ""}`)
        .join("|");
      if (seen.has(signature)) {
        break;
      }
      seen.add(signature);

      const scrolled = await this.scrollNoteManager();
      if (!scrolled) {
        break;
      }
    }

    return [];
  }

  private async readVisiblePublishedNotes(): Promise<PublishedNoteEntry[]> {
    return await this.evaluate<PublishedNoteEntry[]>(`
      (() => {
        ${domHelpersExpression()}
        const parseNoteId = (value) => {
          if (!value) return undefined;
          try {
            const parsed = JSON.parse(value);
            return parsed?.noteTarget?.value?.noteId;
          } catch {
            return undefined;
          }
        };
        return Array.from(document.querySelectorAll('div.note'))
          .map((note) => ({
            noteId: parseNoteId(note.getAttribute('data-impression')),
            publishedAt: normalizeText(note.querySelector('.time')?.textContent),
            title: normalizeText(note.querySelector('.title')?.textContent),
            visibility: normalizeText(note.querySelector('.permission_msg')?.textContent),
          }))
          .filter((entry) => entry.title);
      })()
    `);
  }

  private async scrollNoteManager(): Promise<boolean> {
    const scrolled = await this.evaluate<boolean>(`
      (() => {
        const root = document.scrollingElement || document.documentElement;
        const before = root.scrollTop;
        root.scrollBy(0, Math.max(window.innerHeight, 1200));
        return root.scrollTop !== before;
      })()
    `);
    await delay(NOTE_MANAGER_SCROLL_WAIT_MS);
    return scrolled;
  }

  private async deletePublishedNoteByTitle(title: string): Promise<void> {
    const clicked = await this.evaluate<{ ok: boolean; reason?: string }>(`
      (() => {
        ${domHelpersExpression()}
        const targetTitle = ${JSON.stringify(title)};
        const matches = Array.from(document.querySelectorAll('div.note')).filter((note) => {
          return normalizeText(note.querySelector('.title')?.textContent) === targetTitle;
        });
        if (matches.length === 0) {
          return { ok: false, reason: 'published note not found' };
        }
        if (matches.length > 1) {
          return { ok: false, reason: 'multiple published notes matched title' };
        }
        const button = matches[0]?.querySelector('.control.data-del');
        if (!(button instanceof HTMLElement)) {
          return { ok: false, reason: 'delete button not found' };
        }
        button.click();
        return { ok: true };
      })()
    `);
    if (!clicked.ok) {
      throw new Error(clicked.reason ?? "Could not open the Xiaohongshu delete dialog.");
    }

    await this.confirmDeleteModal();
    await this.waitForPublishedNoteRemoval(title);
  }

  private async confirmDeleteModal(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const clicked = await this.evaluate<boolean>(`
        (() => {
          const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
            return (candidate.textContent || '').replace(/\\s+/g, ' ').trim() === '确定';
          });
          if (!(button instanceof HTMLElement)) {
            return false;
          }
          button.click();
          return true;
        })()
      `);
      if (clicked) {
        return;
      }
      await delay(250);
    }

    throw new Error("Could not find the Xiaohongshu delete confirmation button.");
  }

  private async waitForPublishedNoteRemoval(title: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await this.evaluate<{ hasConfirm: boolean; hasTitle: boolean }>(`
        (() => {
          const normalizedTitle = ${JSON.stringify(title)};
          const noteTitles = Array.from(document.querySelectorAll('div.note .title')).map((node) => {
            return (node.textContent || '').replace(/\\s+/g, ' ').trim();
          });
          const hasConfirm = Array.from(document.querySelectorAll('button')).some((candidate) => {
            return (candidate.textContent || '').replace(/\\s+/g, ' ').trim() === '确定';
          });
          return {
            hasConfirm,
            hasTitle: noteTitles.includes(normalizedTitle),
          };
        })()
      `);
      if (!state.hasConfirm && !state.hasTitle) {
        return;
      }
      await delay(500);
    }

    throw new Error(`Timed out waiting for Xiaohongshu to remove published note: ${title}`);
  }

  private async captureScreenshotBase64(): Promise<string> {
    await this.session.send("Page.enable");
    await this.session.send("Page.bringToFront");
    await delay(500);
    const screenshot = (await this.session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    })) as { data?: string };
    if (!screenshot.data) {
      throw new Error("Could not capture the Xiaohongshu preview screenshot.");
    }
    return screenshot.data;
  }
}

export class XhsBridge {
  constructor(private readonly options: BridgeChromeOptions) {}

  async ensureChrome(): Promise<void> {
    await ensureBridgeChrome(this.options);
  }

  async restartChrome(): Promise<void> {
    await restartBridgeChrome(this.options);
  }

  async openCreatorPublisher(): Promise<XhsPublisher> {
    await this.ensureChrome();
    return new XhsPublisher(await openCreatorSession());
  }

  async openComposePublisher(action: ComposeAction, expectedTitle?: string): Promise<XhsPublisher> {
    await this.ensureChrome();
    return new XhsPublisher(await openComposeSession(action, expectedTitle));
  }
}

export {
  DEFAULT_DEBUG_PORT,
  XHS_CREATOR_HOME_URL,
  XHS_LOGIN_CHECK_URL,
  XHS_LOGIN_URL,
  XHS_NOTE_MANAGER_URL,
  XHS_PUBLISH_URL,
};
