import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface Addon {
  name: string;
  description: string;
  body: string;
  source: "project" | "user";
  detect: { file: string; contains?: string };
}

const USER_ADDONS_DIR = join(CONFIG_DIR, "addons");

function projectAddonsDir(): string {
  return join(process.cwd(), ".lcc", "addons");
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const yamlBlock = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).trim();

  const meta: Record<string, unknown> = {};
  const detect: Record<string, string> = {};
  let inDetect = false;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed === "detect:") {
      inDetect = true;
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();

    if (inDetect && line.startsWith("  ")) {
      detect[key] = val;
    } else {
      inDetect = false;
      meta[key] = val;
    }
  }

  if (Object.keys(detect).length > 0) meta["detect"] = detect;
  return { meta, body };
}

function parseAddonFile(filePath: string, source: "project" | "user"): Addon | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return null;

    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const { meta, body } = parsed;
    if (!body) return null;

    const detect = meta["detect"] as Record<string, string> | undefined;
    if (!detect?.["file"]) return null;

    return {
      name: (meta["name"] as string) || basename(filePath, ".md"),
      description: (meta["description"] as string) || "",
      body,
      source,
      detect: { file: detect["file"], contains: detect["contains"] },
    };
  } catch {
    return null;
  }
}

export function loadAddons(): Addon[] {
  const addons: Addon[] = [];
  const seen = new Set<string>();

  // Project-level addons take priority
  const projDir = projectAddonsDir();
  if (existsSync(projDir)) {
    try {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith(".md")) continue;
        const addon = parseAddonFile(join(projDir, file), "project");
        if (addon) {
          addons.push(addon);
          seen.add(addon.name);
        }
      }
    } catch { /* ignore */ }
  }

  // User-level addons (skip if name already taken by project)
  if (existsSync(USER_ADDONS_DIR)) {
    try {
      for (const file of readdirSync(USER_ADDONS_DIR)) {
        if (!file.endsWith(".md")) continue;
        const addon = parseAddonFile(join(USER_ADDONS_DIR, file), "user");
        if (addon && !seen.has(addon.name)) {
          addons.push(addon);
        }
      }
    } catch { /* ignore */ }
  }

  return addons;
}

export function detectAddons(addons: Addon[], cwd: string): Addon[] {
  return addons.filter((addon) => {
    const filePath = join(cwd, addon.detect.file);
    if (!existsSync(filePath)) return false;
    if (!addon.detect.contains) return true;
    try {
      const content = readFileSync(filePath, "utf-8");
      return content.includes(addon.detect.contains);
    } catch {
      return false;
    }
  });
}
