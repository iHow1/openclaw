import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import { parseContinuityDocument, readRecentContinuitySnapshot } from "./continuity.js";
import type {
  MemoryKind,
  MemoryLayer,
  MemoryMode,
  MemoryScope,
  MemorySearchResult,
} from "./types.js";

export const MEMORY_RECENT_DIR = "memory/recent";
export const MEMORY_INBOX_DIR = "memory/inbox";
export const MEMORY_HISTORY_DIR = "memory/history";
export const MEMORY_SCOPES_DIR = "memory/scopes";

const PROTECTED_CORE_FILES = new Set([
  "MEMORY.md",
  "memory.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
]);
const HEAD_MAX_LINES = 30;
const HEAD_MAX_BYTES = 12_000;

type MemoryRecordMetadata = {
  project?: string;
  sessionKey?: string;
  priority?: string;
  updatedAt?: string;
  scope: MemoryScope;
  kind: MemoryKind;
  layer: MemoryLayer;
  importance: number;
  mtimeMs: number;
};

const metadataCache = new Map<string, MemoryRecordMetadata>();

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeScope(value: string | undefined): MemoryScope | undefined {
  switch (normalizeWhitespace(value).toLowerCase()) {
    case "workspace":
      return "workspace";
    case "project":
      return "project";
    case "session":
      return "session";
    case "user":
      return "user";
    case "agent":
      return "agent";
    case "org":
    case "shared":
      return "org";
    default:
      return undefined;
  }
}

function normalizeKind(value: string | undefined): MemoryKind | undefined {
  switch (normalizeWhitespace(value).toLowerCase()) {
    case "semantic":
      return "semantic";
    case "episodic":
      return "episodic";
    case "procedural":
      return "procedural";
    default:
      return undefined;
  }
}

function normalizeLayer(value: string | undefined): MemoryLayer | undefined {
  switch (normalizeWhitespace(value).toLowerCase()) {
    case "protected_core":
    case "protected-core":
      return "protected_core";
    case "scoped_long_term":
    case "scoped-long-term":
    case "scoped":
      return "scoped_long_term";
    case "session":
      return "session";
    case "top_of_mind":
    case "top-of-mind":
    case "recent":
      return "top_of_mind";
    case "inbox":
      return "inbox";
    case "history":
      return "history";
    default:
      return undefined;
  }
}

function priorityToImportance(priority: string | undefined): number {
  switch (normalizeWhitespace(priority).toLowerCase()) {
    case "highest":
      return 1;
    case "high":
      return 0.8;
    case "medium":
      return 0.55;
    case "low":
      return 0.3;
    default:
      return 0.45;
  }
}

function parseImportance(value: string | undefined, priority: string | undefined): number {
  const parsed = Number.parseFloat(normalizeWhitespace(value));
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.min(1, parsed));
  }
  return priorityToImportance(priority);
}

function inferLayerFromPath(relPath: string): MemoryLayer {
  if (PROTECTED_CORE_FILES.has(relPath)) {
    return "protected_core";
  }
  if (relPath.startsWith(`${MEMORY_RECENT_DIR}/`)) {
    return "top_of_mind";
  }
  if (relPath.startsWith(`${MEMORY_INBOX_DIR}/`)) {
    return "inbox";
  }
  if (relPath.startsWith(`${MEMORY_HISTORY_DIR}/`)) {
    return "history";
  }
  if (relPath.startsWith("sessions/")) {
    return "session";
  }
  return "scoped_long_term";
}

function inferScopeFromPath(relPath: string, layer: MemoryLayer): MemoryScope {
  const tokens = relPath.split("/");
  if (tokens[0] === "memory" && tokens[1] === "scopes") {
    const scoped = normalizeScope(tokens[2]);
    if (scoped) {
      return scoped;
    }
  }
  if (layer === "top_of_mind" || layer === "session" || layer === "history" || layer === "inbox") {
    return "session";
  }
  if (layer === "protected_core") {
    return "workspace";
  }
  return "project";
}

function inferKindFromPath(relPath: string, layer: MemoryLayer): MemoryKind {
  const normalized = relPath.toLowerCase();
  if (normalized.includes("workflow")) {
    return "procedural";
  }
  if (normalized.includes("decision") || normalized.includes("entities/")) {
    return "semantic";
  }
  if (
    layer === "top_of_mind" ||
    layer === "session" ||
    layer === "history" ||
    normalized.includes("active-topics")
  ) {
    return "episodic";
  }
  return "semantic";
}

async function readHead(absPath: string): Promise<string> {
  const handle = await fs.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(HEAD_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_MAX_BYTES, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .slice(0, HEAD_MAX_LINES)
      .join("\n");
  } finally {
    await handle.close();
  }
}

async function loadRecordMetadata(params: {
  workspaceDir: string;
  relPath: string;
}): Promise<MemoryRecordMetadata | null> {
  const relPath = params.relPath.replace(/\\/g, "/");
  const absPath = path.join(params.workspaceDir, relPath);
  try {
    const stat = await fs.stat(absPath);
    const cacheKey = `${absPath}:${stat.mtimeMs}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const head = await readHead(absPath);
    const frontmatter = parseFrontmatterBlock(head);
    const layer = normalizeLayer(frontmatter.layer) ?? inferLayerFromPath(relPath);
    const priority = normalizeWhitespace(frontmatter.priority) || undefined;
    const metadata: MemoryRecordMetadata = {
      project: normalizeWhitespace(frontmatter.project) || undefined,
      sessionKey:
        normalizeWhitespace(frontmatter.session_key) ||
        normalizeWhitespace(frontmatter.sessionKey) ||
        undefined,
      priority,
      updatedAt:
        normalizeWhitespace(frontmatter.updated_at) ||
        normalizeWhitespace(frontmatter.updatedAt) ||
        undefined,
      scope: normalizeScope(frontmatter.scope) ?? inferScopeFromPath(relPath, layer),
      kind: normalizeKind(frontmatter.kind) ?? inferKindFromPath(relPath, layer),
      layer,
      importance: parseImportance(frontmatter.importance, priority),
      mtimeMs: stat.mtimeMs,
    };
    metadataCache.clear();
    metadataCache.set(cacheKey, metadata);
    return metadata;
  } catch {
    return null;
  }
}

async function readCurrentProject(workspaceDir: string): Promise<string | undefined> {
  const recent = await readRecentContinuitySnapshot(workspaceDir);
  if (recent?.content) {
    const parsedRecent = parseContinuityDocument(recent.content);
    if (parsedRecent.project) {
      return parsedRecent.project;
    }
  }
  try {
    const activeContent = await fs.readFile(
      path.join(workspaceDir, "memory", "active-topics.md"),
      "utf-8",
    );
    return parseContinuityDocument(activeContent).project;
  } catch {
    return undefined;
  }
}

function ageDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

function freshnessNote(days: number): string {
  if (days <= 1) {
    return "";
  }
  return `This memory is ${days} days old. Treat it as a point-in-time observation and verify against current files or runtime state before asserting it as current fact.`;
}

function looksLikeCodeStateClaim(entry: MemorySearchResult): boolean {
  const haystack = `${entry.path}\n${entry.snippet}`;
  return /(\.tsx?\b|\.jsx?\b|\.json\b|src\/|#L\d+|function\s+\w+|class\s+\w+|handler|route|config|flag|path)/i.test(
    haystack,
  );
}

function layerBoost(layer: MemoryLayer): number {
  switch (layer) {
    case "top_of_mind":
      return 0.28;
    case "protected_core":
      return 0.08;
    case "scoped_long_term":
      return 0.04;
    case "history":
      return -0.18;
    case "inbox":
      return -0.3;
    case "session":
      return 0.12;
  }
}

function scopeBoost(params: {
  scope: MemoryScope;
  entryProject?: string;
  currentProject?: string;
  entrySessionKey?: string;
  sessionKey?: string;
}): number {
  let boost = 0;
  if (params.scope === "session") {
    boost += 0.08;
  }
  if (params.scope === "workspace") {
    boost += 0.03;
  }
  if (
    params.entryProject &&
    params.currentProject &&
    params.entryProject === params.currentProject
  ) {
    boost += 0.12;
  }
  if (params.entrySessionKey && params.sessionKey && params.entrySessionKey === params.sessionKey) {
    boost += 0.14;
  }
  return boost;
}

function stalenessPenalty(metadata: MemoryRecordMetadata): number {
  const days = ageDays(metadata.mtimeMs);
  if (days <= 1) {
    return 0;
  }
  return Math.min(0.25, (days - 1) * 0.015);
}

function shouldIncludeInMode(metadata: MemoryRecordMetadata, mode: MemoryMode): boolean {
  if (mode === "incognito") {
    return false;
  }
  if (metadata.layer === "inbox" || metadata.layer === "history") {
    return false;
  }
  if (mode === "project_only" && (metadata.scope === "user" || metadata.scope === "org")) {
    return false;
  }
  return true;
}

export async function postProcessMemorySearchResults(params: {
  workspaceDir: string;
  results: MemorySearchResult[];
  sessionKey?: string;
  mode?: MemoryMode;
}): Promise<MemorySearchResult[]> {
  const mode = params.mode ?? "normal";
  if (mode === "incognito") {
    return [];
  }

  const currentProject = await readCurrentProject(params.workspaceDir);
  const enriched = await Promise.all(
    params.results.map(async (entry) => {
      const metadata = await loadRecordMetadata({
        workspaceDir: params.workspaceDir,
        relPath: entry.path,
      });
      if (!metadata || !shouldIncludeInMode(metadata, mode)) {
        return null;
      }

      const days = ageDays(metadata.mtimeMs);
      const note = days > 1 && looksLikeCodeStateClaim(entry) ? freshnessNote(days) : "";
      const adjustedScore =
        entry.score +
        layerBoost(metadata.layer) +
        scopeBoost({
          scope: metadata.scope,
          entryProject: metadata.project,
          currentProject,
          entrySessionKey: metadata.sessionKey,
          sessionKey: params.sessionKey,
        }) +
        metadata.importance * 0.08 -
        stalenessPenalty(metadata);
      const snippet = note ? `${entry.snippet.trim()}\n\nFreshness: ${note}` : entry.snippet;

      return {
        ...entry,
        score: adjustedScore,
        snippet,
        scope: metadata.scope,
        kind: metadata.kind,
        layer: metadata.layer,
        priority: metadata.priority,
        importance: metadata.importance,
        updatedAt: metadata.updatedAt,
        freshnessNote: note || undefined,
      } satisfies MemorySearchResult;
    }),
  );

  const filtered: MemorySearchResult[] = [];
  for (const entry of enriched) {
    if (entry) {
      filtered.push(entry);
    }
  }
  return filtered.toSorted((left, right) => right.score - left.score);
}
