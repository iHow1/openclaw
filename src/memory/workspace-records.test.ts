import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemorySearchResult } from "./types.js";
import { postProcessMemorySearchResults } from "./workspace-records.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-records-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "memory", "recent", "snapshots"), { recursive: true });
  await fs.mkdir(path.join(dir, "memory", "inbox"), { recursive: true });
  await fs.mkdir(path.join(dir, "memory", "history", "journal"), { recursive: true });
  await fs.mkdir(path.join(dir, "memory", "scopes", "project", "demo"), { recursive: true });
  await fs.mkdir(path.join(dir, "memory", "scopes", "user", "default"), { recursive: true });
  return dir;
}

async function writeFile(workspace: string, relPath: string, content: string): Promise<void> {
  const absPath = path.join(workspace, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, "utf-8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("postProcessMemorySearchResults", () => {
  it("prioritizes recent continuity and excludes inbox/history from default recall", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      workspace,
      "memory/recent/latest.md",
      `---
type: recent_snapshot
status: active
priority: highest
updated_at: 2026-04-04T01:00:00.000Z
project: demo
session_key: agent:main:main
---

# Recent Continuity Snapshot
`,
    );
    await writeFile(
      workspace,
      "memory/scopes/project/demo/semantic.md",
      `---
type: scoped_memory
scope: project
kind: semantic
priority: medium
updated_at: 2026-04-03T01:00:00.000Z
project: demo
---

# Demo Memory
`,
    );
    await writeFile(
      workspace,
      "memory/inbox/queued.md",
      `---
type: memory_candidate
scope: project
kind: episodic
priority: high
---
`,
    );
    await writeFile(
      workspace,
      "memory/history/journal/2026-04-04.jsonl",
      `{"timestamp":"2026-04-04T01:00:00.000Z"}`,
    );

    const results: MemorySearchResult[] = [
      {
        path: "memory/scopes/project/demo/semantic.md",
        startLine: 1,
        endLine: 5,
        score: 0.6,
        snippet: "Stable project fact",
        source: "memory",
      },
      {
        path: "memory/recent/latest.md",
        startLine: 1,
        endLine: 5,
        score: 0.6,
        snippet: "Current task is active",
        source: "memory",
      },
      {
        path: "memory/inbox/queued.md",
        startLine: 1,
        endLine: 4,
        score: 0.9,
        snippet: "Pending candidate",
        source: "memory",
      },
      {
        path: "memory/history/journal/2026-04-04.jsonl",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "History entry",
        source: "memory",
      },
    ];

    const processed = await postProcessMemorySearchResults({
      workspaceDir: workspace,
      results,
      sessionKey: "agent:main:main",
    });

    expect(processed).toHaveLength(2);
    expect(processed[0]?.path).toBe("memory/recent/latest.md");
    expect(processed[1]?.path).toBe("memory/scopes/project/demo/semantic.md");
  });

  it("filters user/org scoped memories in project_only mode", async () => {
    const workspace = await makeWorkspace();
    await writeFile(
      workspace,
      "memory/scopes/user/default/semantic.md",
      `---
type: scoped_memory
scope: user
kind: semantic
priority: high
---
`,
    );
    await writeFile(
      workspace,
      "memory/scopes/project/demo/semantic.md",
      `---
type: scoped_memory
scope: project
kind: semantic
priority: high
project: demo
---
`,
    );

    const processed = await postProcessMemorySearchResults({
      workspaceDir: workspace,
      mode: "project_only",
      results: [
        {
          path: "memory/scopes/user/default/semantic.md",
          startLine: 1,
          endLine: 4,
          score: 0.9,
          snippet: "Personal preference",
          source: "memory",
        },
        {
          path: "memory/scopes/project/demo/semantic.md",
          startLine: 1,
          endLine: 5,
          score: 0.7,
          snippet: "Project rule",
          source: "memory",
        },
      ],
    });

    expect(processed).toHaveLength(1);
    expect(processed[0]?.path).toBe("memory/scopes/project/demo/semantic.md");
  });

  it("adds freshness notes for old code-state memories", async () => {
    const workspace = await makeWorkspace();
    const relPath = "memory/scopes/project/demo/semantic.md";
    const absPath = path.join(workspace, relPath);
    await writeFile(
      workspace,
      relPath,
      `---
type: scoped_memory
scope: project
kind: semantic
priority: medium
project: demo
---
`,
    );
    const oldDate = new Date("2026-03-20T00:00:00.000Z");
    await fs.utimes(absPath, oldDate, oldDate);

    const processed = await postProcessMemorySearchResults({
      workspaceDir: workspace,
      results: [
        {
          path: relPath,
          startLine: 1,
          endLine: 3,
          score: 0.8,
          snippet: "src/browser/client.ts#L10 still uses the old handler flag.",
          source: "memory",
        },
      ],
    });

    expect(processed).toHaveLength(1);
    expect(processed[0]?.freshnessNote).toContain("point-in-time observation");
    expect(processed[0]?.snippet).toContain("Freshness:");
  });
});
