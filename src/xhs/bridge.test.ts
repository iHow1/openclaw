import { describe, expect, it, vi } from "vitest";
import {
  resolveChromeProfileDir,
  selectComposeCandidate,
  type ComposePageProbe,
} from "./bridge.ts";

function composeProbe(overrides: Partial<ComposePageProbe> = {}): ComposePageProbe {
  return {
    bodyPreview: "",
    hasExpectedTitle: false,
    hasPublish: false,
    hasSave: false,
    href: "https://creator.xiaohongshu.com/publish/publish?from=tab_switch",
    ...overrides,
  };
}

describe("resolveChromeProfileDir", () => {
  it("uses the shared profile override when no account is provided", () => {
    vi.stubEnv("OPENCLAW_XHS_PROFILE_DIR", "/tmp/shared-profile");
    expect(resolveChromeProfileDir()).toBe("/tmp/shared-profile");
  });

  it("derives account-specific profiles from the account base", () => {
    vi.stubEnv("OPENCLAW_XHS_PROFILE_BASE", "/tmp/xhs-profiles");
    expect(resolveChromeProfileDir("team/alpha")).toBe("/tmp/xhs-profiles/team_alpha");
  });
});

describe("selectComposeCandidate", () => {
  it("chooses the only saveable compose page", () => {
    const probes = [composeProbe(), composeProbe({ hasSave: true })];
    expect(selectComposeCandidate(probes, "save")).toBe(1);
  });

  it("prefers the expected title when multiple compose pages are open", () => {
    const probes = [
      composeProbe({ hasSave: true }),
      composeProbe({ hasExpectedTitle: true, hasSave: true }),
    ];
    expect(selectComposeCandidate(probes, "save", "目标标题")).toBe(1);
  });

  it("fails clearly when multiple publish targets remain ambiguous", () => {
    const probes = [composeProbe({ hasPublish: true }), composeProbe({ hasPublish: true })];
    expect(() => selectComposeCandidate(probes, "publish")).toThrow(
      "Multiple publish-ready compose pages are open.",
    );
  });

  it("fails when no saveable compose page exists", () => {
    expect(() => selectComposeCandidate([composeProbe()], "save")).toThrow(
      "No editable Xiaohongshu compose page is open.",
    );
  });
});
