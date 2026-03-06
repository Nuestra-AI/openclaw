/**
 * Shared helpers for loading config overlays, validating workspace paths,
 * copying bootstrap files, and applying tool-policy overrides.
 *
 * Used by both `commands/agent.ts` (CLI entry) and
 * `auto-reply/reply/get-reply.ts` (channel/webhook entry) to avoid
 * duplicating security-sensitive logic.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OpenClawConfig } from "./config.js";
import { parseConfigJson5 } from "./config.js";
import { MissingEnvVarError, resolveConfigEnvVars } from "./env-substitution.js";
import { applyMergePatch } from "./merge-patch.js";
import { normalizeAgentId } from "../routing/session-key.js";

// ── Config overlay loading ──────────────────────────────────────────

export interface LoadConfigOverlayOpts {
  cfg: OpenClawConfig;
  configDir: string;
  /** Pre-merge workspaceRoot snapshot (from base config). */
  workspaceRoot: string | undefined;
  /** Label used in error messages (e.g. "--config-dir", "config-dir override"). */
  label?: string;
  /** Called when the overlay file cannot be parsed. */
  onParseError?: (msg: string) => void;
}

/**
 * Resolves `configDir` under `workspaceRoot` (if set), reads the
 * `openclaw.json` overlay from the resulting directory, and merges it into
 * `cfg` in place.  Silently skips if the overlay file does not exist.
 */
export async function loadAndMergeConfigOverlay(opts: LoadConfigOverlayOpts): Promise<void> {
  const { cfg, configDir, workspaceRoot, label = "--config-dir", onParseError } = opts;

  const resolvedConfigDir = resolvePathUnderRoot(configDir, workspaceRoot, label);

  const overlayPath = path.join(resolvedConfigDir, "openclaw.json");
  try {
    const overlayRaw = await fs.readFile(overlayPath, "utf-8");
    const parseResult = parseConfigJson5(overlayRaw);
    if (
      parseResult.ok &&
      parseResult.parsed &&
      typeof parseResult.parsed === "object" &&
      !Array.isArray(parseResult.parsed)
    ) {
      const resolved = resolveConfigEnvVars(parseResult.parsed);
      const merged = applyMergePatch(cfg, resolved, { mergeObjectArraysById: true });
      Object.assign(cfg, merged);
    } else if (!parseResult.ok) {
      onParseError?.(`Failed to parse ${overlayPath}: ${parseResult.error}`);
    }
  } catch (err: any) {
    if (err instanceof MissingEnvVarError) {
      throw new Error(`Config overlay ${overlayPath}: ${err.message}`);
    }
    if (err.code !== "ENOENT") throw err;
  }
}

// ── Workspace-path resolution & validation ──────────────────────────

/**
 * When `workspaceRoot` is set, resolves `rawPath` as a relative child of the
 * root and returns the absolute result.  Absolute paths and traversal
 * (`..`) segments are rejected — callers must pass a relative subdirectory
 * (e.g. `"stacks/acme-corp"`).
 *
 * When `workspaceRoot` is **not** set, falls back to `path.resolve(rawPath)`
 * (backwards-compatible, no boundary enforcement).
 */
export function resolvePathUnderRoot(
  rawPath: string,
  workspaceRoot: string | undefined,
  label: string,
): string {
  if (!workspaceRoot) {
    return path.resolve(rawPath);
  }

  if (rawPath === "" || path.isAbsolute(rawPath)) {
    throw new Error(
      `${label} must be a relative path when workspaceRoot is set, got: ${rawPath}`,
    );
  }

  const normalized = path.normalize(rawPath);
  const sep = path.sep;
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.endsWith(`${sep}..`) ||
    normalized.includes(`${sep}..${sep}`)
  ) {
    throw new Error(
      `${label} must not traverse above workspaceRoot, got: ${rawPath}`,
    );
  }

  const base = path.resolve(workspaceRoot);
  const resolved = path.join(base, normalized);

  // Sanity check: resolved must be a strict child (not equal to base).
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(
      `${label} must be a child of workspaceRoot (${base}), got: ${resolved}`,
    );
  }

  return resolved;
}

// ── Bootstrap file copying ──────────────────────────────────────────

const BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md",
  "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md",
] as const;

export interface CopyBootstrapFilesOpts {
  configDir: string;
  workspaceDir: string;
  /** Label used in error messages (e.g. "--config-dir"). */
  label?: string;
  /** Called when no bootstrap files were found. */
  onNoCopied?: (msg: string) => void;
}

/**
 * Copies well-known bootstrap `.md` files from `configDir` into
 * `workspaceDir`, silently skipping files that do not exist.
 * Returns the number of files copied.
 */
export async function copyBootstrapFiles(opts: CopyBootstrapFilesOpts): Promise<number> {
  const { configDir, workspaceDir, label = "--config-dir", onNoCopied } = opts;

  try {
    await fs.access(configDir);
  } catch {
    throw new Error(`${label} path does not exist: ${configDir}`);
  }

  let copiedCount = 0;
  for (const filename of BOOTSTRAP_FILE_NAMES) {
    const srcPath = path.join(configDir, filename);
    try {
      const content = await fs.readFile(srcPath, "utf-8");
      await fs.writeFile(path.join(workspaceDir, filename), content, "utf-8");
      copiedCount++;
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  if (copiedCount === 0) {
    onNoCopied?.(`${label} ${configDir} contains no bootstrap .md files`);
  }
  return copiedCount;
}

// ── Tool-policy overrides ───────────────────────────────────────────

const VALID_TOOL_PROFILES = ["minimal", "coding", "messaging", "full"] as const;

export interface ApplyToolOverridesOpts {
  cfg: OpenClawConfig;
  agentId: string;
  toolsProfileOverride?: string;
  toolsAllowOverride?: string[];
  toolsDenyOverride?: string[];
}

/**
 * Validates and applies `--tools-profile`, `--tools-allow`, and
 * `--tools-deny` overrides to the agent entry in `cfg` (mutating it).
 */
export function applyToolOverrides(opts: ApplyToolOverridesOpts): void {
  const { cfg, agentId, toolsProfileOverride, toolsAllowOverride, toolsDenyOverride } = opts;

  if (toolsProfileOverride && !(VALID_TOOL_PROFILES as readonly string[]).includes(toolsProfileOverride)) {
    throw new Error(
      `Invalid tools-profile "${toolsProfileOverride}". Use one of: ${VALID_TOOL_PROFILES.join(", ")}`,
    );
  }

  if (!toolsProfileOverride && !toolsAllowOverride && !toolsDenyOverride) return;

  const agentEntry = cfg.agents?.list?.find(
    (a: any) => normalizeAgentId(a.id) === agentId,
  );
  const toolsOverride: Record<string, unknown> = { ...(agentEntry?.tools ?? {}) };
  if (toolsProfileOverride) toolsOverride.profile = toolsProfileOverride;
  if (toolsAllowOverride) toolsOverride.allow = toolsAllowOverride;
  if (toolsDenyOverride) toolsOverride.deny = toolsDenyOverride;

  if (agentEntry) {
    agentEntry.tools = toolsOverride as any;
  } else {
    cfg.agents = cfg.agents ?? ({} as any);
    cfg.agents!.list = cfg.agents!.list ?? [];
    cfg.agents!.list.push({
      id: agentId,
      tools: toolsOverride,
    } as any);
  }
}
