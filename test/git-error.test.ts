import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultRunGit } from "../src/core.js";

/**
 * #6 — the real execa failure surface for `defaultRunGit`: a failing git
 * command must surface the exact argv AND the stderr in the thrown message
 * (the replaced execFileSync call lost both). Fully offline: real git
 * binary + real execa against a throwaway tmp repo — no network, no mocks.
 */

describe("defaultRunGit execa failure surface (#6)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("returns stdout as a string on success", () => {
    dir = mkdtempSync(join(tmpdir(), "pm-git-ok-"));
    expect(defaultRunGit(["init", "-q"], dir)).toBe("");
  });

  it("throws with argv + stderr when git fails", () => {
    dir = mkdtempSync(join(tmpdir(), "pm-git-fail-"));
    defaultRunGit(["init", "-q"], dir);
    const missing = "pm-autopilot-#6-missing-ref";
    try {
      defaultRunGit(["show", missing], dir);
      expect.unreachable("git show with a guaranteed-missing ref must throw");
    } catch (error) {
      const message = (error as Error).message;
      // The exact argv …
      expect(message).toContain("git show");
      expect(message).toContain(missing);
      // … and the stderr explaining the failure.
      expect(message).toContain("fatal:");
      expect(message).toContain(missing);
    }
  });
});
