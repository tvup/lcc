import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  source: "project" | "user";
}

const USER_COMMANDS_DIR = join(CONFIG_DIR, "commands");

function projectCommandsDir(): string {
  return join(process.cwd(), ".lcc", "commands");
}

function parseSkillFile(filePath: string, source: "project" | "user"): Skill | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return null;

    const name = basename(filePath, ".md");
    const lines = raw.split("\n");
    let description = "";
    let bodyStart = 0;

    // First non-empty line starting with # is the description
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      if (line.startsWith("# ")) {
        description = line.slice(2).trim();
        bodyStart = i + 1;
      }
      break;
    }

    const body = lines.slice(bodyStart).join("\n").trim();
    if (!body) return null;

    return { name, description, body, source };
  } catch {
    return null;
  }
}

export function loadSkills(): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  // Project-level commands take priority
  const projDir = projectCommandsDir();
  if (existsSync(projDir)) {
    try {
      for (const file of readdirSync(projDir)) {
        if (!file.endsWith(".md")) continue;
        const skill = parseSkillFile(join(projDir, file), "project");
        if (skill) {
          skills.push(skill);
          seen.add(skill.name);
        }
      }
    } catch { /* ignore */ }
  }

  // User-level commands (skip if name already taken by project)
  if (existsSync(USER_COMMANDS_DIR)) {
    try {
      for (const file of readdirSync(USER_COMMANDS_DIR)) {
        if (!file.endsWith(".md")) continue;
        const skill = parseSkillFile(join(USER_COMMANDS_DIR, file), "user");
        if (skill && !seen.has(skill.name)) {
          skills.push(skill);
        }
      }
    } catch { /* ignore */ }
  }

  return skills;
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}

export function renderSkill(skill: Skill, args: string): string {
  return skill.body.replace(/\$ARGUMENTS/g, args);
}
