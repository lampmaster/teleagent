import { exec } from "node:child_process";
import type { FeatureFlags } from "../optimizations/flags.js";
import type { Tool, ToolDefinitionVariant, ToolResult } from "./Tool.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 8_000;

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one command. Swapped out by the benchmark for deterministic fixtures. */
export type CommandRunner = (command: string) => Promise<ExecOutcome>;

export interface ExecToolOptions {
  timeoutMs?: number;
  runner?: CommandRunner;
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
  private readonly runner: CommandRunner;

  constructor(options: ExecToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.runner = options.runner ?? ((command) => this.spawn(command));
  }

  /**
   * Batching is advertised in prose rather than in the schema. The audit showed
   * the multi-fact scenarios spending 5 turns on 2.4 tool calls; `sh` already
   * chains commands with `;`, so nothing about the input shape has to change.
   * An earlier version added a `commands` array parameter instead, and that
   * extra optional parameter measurably stopped qwen3:1.7b emitting tool calls
   * at all.
   */
  definition(flags: FeatureFlags): ToolDefinitionVariant | undefined {
    if (!flags.batchIndependentTools) {
      return undefined;
    }

    return {
      description:
        `${this.description} When you need several independent facts, ask for them in one ` +
        "command separated by `;`, for example `date; hostname; nproc`. " +
        "Never chain a command that needs the output of another.",
      parameters: this.parameters,
    };
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
      const outcome = await this.runner(command);
      return { content: JSON.stringify(truncateOutcome(outcome)) };
    } catch (error) {
      return { content: describeError(error), isError: true };
    }
  }

  private spawn(command: string): Promise<ExecOutcome> {
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

          resolve({ stdout, stderr, exitCode: error?.code ?? 0 });
        },
      );
    });
  }
}

function truncateOutcome(outcome: ExecOutcome): ExecOutcome {
  return {
    stdout: truncate(outcome.stdout),
    stderr: truncate(outcome.stderr),
    exitCode: outcome.exitCode,
  };
}

function truncate(output: string): string {
  return output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : output;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
