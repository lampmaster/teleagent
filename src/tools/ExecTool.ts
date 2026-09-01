import { exec } from "node:child_process";
import type { Tool, ToolResult } from "./Tool.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 8_000;

export interface ExecToolOptions {
  timeoutMs?: number;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ExecTool implements Tool {
  readonly name = "exec";
  readonly description =
    "Execute a shell command on the local machine and return its stdout, stderr and exit code. " +
    "Use it for commands such as `date`, `ps -axo pid,comm,%mem` or `curl https://example.com`.";
  readonly parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
    },
    required: ["command"],
  };

  private readonly timeoutMs: number;

  constructor(options: ExecToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  async execute(input: unknown): Promise<ToolResult> {
    const command = (input as { command?: unknown } | null)?.command;

    if (typeof command !== "string" || command.trim().length === 0) {
      return {
        content: 'Invalid input: expected an object with a non-empty "command" string.',
        isError: true,
      };
    }

    try {
      const outcome = await this.run(command);
      return { content: JSON.stringify(outcome) };
    } catch (error) {
      return { content: describeError(error), isError: true };
    }
  }

  private run(command: string): Promise<ExecOutcome> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          killSignal: "SIGKILL",
        },
        (error, stdout, stderr) => {
          if (error && (error.killed || error.signal)) {
            reject(
              new Error(
                `Command timed out after ${this.timeoutMs}ms and was terminated: ${command}`,
              ),
            );
            return;
          }

          resolve({
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            exitCode: error?.code ?? 0,
          });
        },
      );
    });
  }
}

function truncate(output: string): string {
  return output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : output;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
