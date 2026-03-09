import { describe, expect, it, vi } from "vitest";
import { parseSmokeArgs, runSmoke } from "./smoke.ts";

describe("parseSmokeArgs", () => {
  it("defaults to a non-publishing smoke run", () => {
    expect(parseSmokeArgs([])).toEqual({
      account: undefined,
      allowLivePublish: false,
      headless: false,
      publishCommand: "none",
      reportDir: undefined,
    });
  });

  it("parses the live publish command options", () => {
    expect(
      parseSmokeArgs([
        "--account",
        "team-a",
        "--headless",
        "--allow-live-publish",
        "--publish-command",
        "click-publish",
        "--report-dir",
        "/tmp/xhs-smoke",
      ]),
    ).toEqual({
      account: "team-a",
      allowLivePublish: true,
      headless: true,
      publishCommand: "click-publish",
      reportDir: "/tmp/xhs-smoke",
    });
  });
});

describe("runSmoke live publish guard", () => {
  it("refuses live publish smoke without the explicit env gate", async () => {
    vi.stubEnv("OPENCLAW_XHS_ALLOW_LIVE_PUBLISH", undefined);
    await expect(
      runSmoke({
        account: undefined,
        allowLivePublish: true,
        headless: false,
        publishCommand: "publish",
      }),
    ).rejects.toThrow("Set OPENCLAW_XHS_ALLOW_LIVE_PUBLISH=1 before running live publish smoke.");
  });
});
