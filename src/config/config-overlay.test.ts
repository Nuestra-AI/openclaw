import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  applyToolOverrides,
  copyBootstrapFiles,
  loadAndMergeConfigOverlay,
  resolvePathUnderRoot,
} from "./config-overlay.js";

// ── helpers ─────────────────────────────────────────────────────────

let fixtureRoot = "";
let caseId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-overlay-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function caseDir(): string {
  return path.join(fixtureRoot, `case-${caseId++}`);
}

function baseCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

// ── resolvePathUnderRoot ────────────────────────────────────────────

describe("resolvePathUnderRoot", () => {
  it("falls back to path.resolve when workspaceRoot is undefined", () => {
    const result = resolvePathUnderRoot("/anywhere", undefined, "--workspace");
    expect(result).toBe(path.resolve("/anywhere"));
  });

  it("resolves a relative path under the root", () => {
    const base = path.resolve("/data");
    const result = resolvePathUnderRoot("stacks/s1", base, "--workspace");
    expect(result).toBe(path.join(base, "stacks", "s1"));
  });

  it("rejects an absolute path when workspaceRoot is set", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot("/etc/passwd", base, "--workspace"),
    ).toThrow(/must be a relative path when workspaceRoot is set/);
  });

  it("rejects traversal via ..", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot("../etc/passwd", base, "--workspace"),
    ).toThrow(/must not traverse above workspaceRoot/);
  });

  it("rejects traversal via nested ..", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot("stacks/../../etc", base, "--workspace"),
    ).toThrow(/must not traverse above workspaceRoot/);
  });

  it("rejects bare . (resolves to root itself)", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot(".", base, "--workspace"),
    ).toThrow(/must be a child of workspaceRoot/);
  });

  it("rejects empty string (resolves to root itself)", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot("", base, "--workspace"),
    ).toThrow(/must be a relative path when workspaceRoot is set/);
  });

  it("includes the label in the error message", () => {
    const base = path.resolve("/data");
    expect(() =>
      resolvePathUnderRoot("/outside", base, "my-label"),
    ).toThrow(/my-label must be a relative path/);
  });
});

// ── loadAndMergeConfigOverlay ───────────────────────────────────────

describe("loadAndMergeConfigOverlay", () => {
  it("merges overlay properties into cfg", async () => {
    const dir = caseDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "openclaw.json"),
      JSON.stringify({ session: { timeout: 999 } }),
      "utf-8",
    );

    const cfg = baseCfg();
    await loadAndMergeConfigOverlay({
      cfg,
      configDir: dir,
      workspaceRoot: undefined,
    });

    expect((cfg as any).session?.timeout).toBe(999);
  });

  it("silently skips when openclaw.json does not exist", async () => {
    const dir = caseDir();
    await fs.mkdir(dir, { recursive: true });
    // no openclaw.json written

    const cfg = baseCfg();
    await expect(
      loadAndMergeConfigOverlay({ cfg, configDir: dir, workspaceRoot: undefined }),
    ).resolves.toBeUndefined();
  });

  it("resolves relative configDir under workspaceRoot", async () => {
    const root = caseDir();
    const subdir = path.join(root, "stacks", "acme");
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(
      path.join(subdir, "openclaw.json"),
      JSON.stringify({ session: { timeout: 42 } }),
      "utf-8",
    );

    const cfg = baseCfg();
    await loadAndMergeConfigOverlay({
      cfg,
      configDir: "stacks/acme",
      workspaceRoot: root,
    });

    expect((cfg as any).session?.timeout).toBe(42);
  });

  it("rejects absolute configDir when workspaceRoot is set", async () => {
    const dir = caseDir();
    await fs.mkdir(dir, { recursive: true });

    await expect(
      loadAndMergeConfigOverlay({
        cfg: baseCfg(),
        configDir: "/outside",
        workspaceRoot: dir,
      }),
    ).rejects.toThrow(/must be a relative path when workspaceRoot is set/);
  });

  it("rejects traversal in configDir", async () => {
    const dir = caseDir();
    await fs.mkdir(dir, { recursive: true });

    await expect(
      loadAndMergeConfigOverlay({
        cfg: baseCfg(),
        configDir: "../etc",
        workspaceRoot: dir,
      }),
    ).rejects.toThrow(/must not traverse above workspaceRoot/);
  });

  it("calls onParseError for malformed JSON", async () => {
    const dir = caseDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "openclaw.json"), "NOT VALID {{{", "utf-8");

    const errors: string[] = [];
    await loadAndMergeConfigOverlay({
      cfg: baseCfg(),
      configDir: dir,
      workspaceRoot: undefined,
      onParseError: (msg) => errors.push(msg),
    });

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Failed to parse");
  });

  it("uses custom label in workspaceRoot error", async () => {
    await expect(
      loadAndMergeConfigOverlay({
        cfg: baseCfg(),
        configDir: "/outside",
        workspaceRoot: "/data",
        label: "config-dir override",
      }),
    ).rejects.toThrow(/config-dir override must be a relative path/);
  });
});

// ── copyBootstrapFiles ──────────────────────────────────────────────

describe("copyBootstrapFiles", () => {
  it("copies existing bootstrap files into workspace", async () => {
    const configDir = caseDir();
    const workspaceDir = caseDir();
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    await fs.writeFile(path.join(configDir, "AGENTS.md"), "# agents", "utf-8");
    await fs.writeFile(path.join(configDir, "SOUL.md"), "# soul", "utf-8");

    const count = await copyBootstrapFiles({ configDir, workspaceDir });
    expect(count).toBe(2);

    expect(await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf-8")).toBe("# agents");
    expect(await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf-8")).toBe("# soul");
  });

  it("silently skips missing files", async () => {
    const configDir = caseDir();
    const workspaceDir = caseDir();
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    // only IDENTITY.md exists
    await fs.writeFile(path.join(configDir, "IDENTITY.md"), "id", "utf-8");

    const count = await copyBootstrapFiles({ configDir, workspaceDir });
    expect(count).toBe(1);
  });

  it("calls onNoCopied when no bootstrap files exist", async () => {
    const configDir = caseDir();
    const workspaceDir = caseDir();
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    const warnings: string[] = [];
    const count = await copyBootstrapFiles({
      configDir,
      workspaceDir,
      onNoCopied: (msg) => warnings.push(msg),
    });

    expect(count).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("no bootstrap .md files");
  });

  it("throws when configDir does not exist", async () => {
    const workspaceDir = caseDir();
    await fs.mkdir(workspaceDir, { recursive: true });

    await expect(
      copyBootstrapFiles({
        configDir: path.join(fixtureRoot, "nonexistent"),
        workspaceDir,
      }),
    ).rejects.toThrow(/path does not exist/);
  });
});

// ── applyToolOverrides ──────────────────────────────────────────────

describe("applyToolOverrides", () => {
  it("does nothing when no overrides are provided", () => {
    const cfg = baseCfg({ agents: { list: [{ id: "main" }] } } as any);
    applyToolOverrides({ cfg, agentId: "main" });
    expect((cfg.agents as any).list[0].tools).toBeUndefined();
  });

  it("sets profile on an existing agent", () => {
    const cfg = baseCfg({
      agents: { list: [{ id: "main", tools: {} }] },
    } as any);
    applyToolOverrides({ cfg, agentId: "main", toolsProfileOverride: "minimal" });
    expect((cfg.agents as any).list[0].tools.profile).toBe("minimal");
  });

  it("sets allow and deny lists", () => {
    const cfg = baseCfg({
      agents: { list: [{ id: "main" }] },
    } as any);
    applyToolOverrides({
      cfg,
      agentId: "main",
      toolsAllowOverride: ["tool-a"],
      toolsDenyOverride: ["tool-b"],
    });
    expect((cfg.agents as any).list[0].tools.allow).toEqual(["tool-a"]);
    expect((cfg.agents as any).list[0].tools.deny).toEqual(["tool-b"]);
  });

  it("creates agent entry when it does not exist", () => {
    const cfg = baseCfg();
    applyToolOverrides({ cfg, agentId: "new-agent", toolsProfileOverride: "full" });
    const list = (cfg.agents as any).list;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("new-agent");
    expect(list[0].tools.profile).toBe("full");
  });

  it("throws for invalid profile", () => {
    const cfg = baseCfg();
    expect(() =>
      applyToolOverrides({ cfg, agentId: "x", toolsProfileOverride: "invalid" }),
    ).toThrow(/Invalid tools-profile "invalid"/);
  });

  it("preserves existing tools properties when adding overrides", () => {
    const cfg = baseCfg({
      agents: { list: [{ id: "main", tools: { existing: true } }] },
    } as any);
    applyToolOverrides({ cfg, agentId: "main", toolsProfileOverride: "coding" });
    const tools = (cfg.agents as any).list[0].tools;
    expect(tools.profile).toBe("coding");
    expect(tools.existing).toBe(true);
  });
});
