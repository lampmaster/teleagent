import type { SkillLoader } from "../skills/SkillLoader.js";
import type { Tool, ToolResult } from "./Tool.js";

export class LoadSkillTool implements Tool {
  readonly name = "load_skill";
  readonly description =
    "Load the full instructions of a skill by its name. " +
    "Call this before following a skill mentioned in the list of available skills.";
  readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the skill to load.",
      },
    },
    required: ["name"],
  };

  private readonly skillLoader: SkillLoader;

  constructor(skillLoader: SkillLoader) {
    this.skillLoader = skillLoader;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const name = (input as { name?: unknown } | null)?.name;

    if (typeof name !== "string" || name.trim().length === 0) {
      return {
        content: 'Invalid input: expected an object with a non-empty "name" string.',
        isError: true,
      };
    }

    try {
      return { content: await this.skillLoader.load(name.trim()) };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}
