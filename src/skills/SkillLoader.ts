import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SkillMetadata = {
  name: string;
  description: string;
};

interface Skill extends SkillMetadata {
  instructions: string;
}

export class SkillLoader {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async list(): Promise<SkillMetadata[]> {
    const skills = await this.readAll();
    return skills.map(({ name, description }) => ({ name, description }));
  }

  /** Returns the full instructions of a skill. Throws if the skill is unknown. */
  async load(name: string): Promise<string> {
    const skills = await this.readAll();
    const skill = skills.find((candidate) => candidate.name === name);

    if (!skill) {
      const known = skills.map((candidate) => candidate.name).join(", ");
      throw new Error(
        `Unknown skill: "${name}". Available skills: ${known || "none"}`,
      );
    }

    return skill.instructions;
  }

  private async readAll(): Promise<Skill[]> {
    let fileNames: string[];

    try {
      fileNames = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return [];
    }

    const skills: Skill[] = [];

    for (const fileName of fileNames.filter((file) => file.endsWith(".md"))) {
      const raw = await readFile(join(this.directory, fileName), "utf8");
      const skill = parseSkill(raw);

      if (skill) {
        skills.push(skill);
      } else {
        console.error(`Skipping skill file without valid frontmatter: ${fileName}`);
      }
    }

    return skills;
  }
}

/**
 * Parses the minimal frontmatter format:
 *
 *   ---
 *   name: some-skill
 *   description: What it does.
 *   ---
 *   instructions...
 */
function parseSkill(raw: string): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());

  if (!match) {
    return null;
  }

  const [, frontmatter = "", instructions = ""] = match;
  const fields = new Map<string, string>();

  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");

    if (separator > 0) {
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");

  if (!name || !description) {
    return null;
  }

  return { name, description, instructions: instructions.trim() };
}
