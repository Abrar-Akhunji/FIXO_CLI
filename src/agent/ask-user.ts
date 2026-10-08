/**
 * ask_user_question — a tool result, never a hung prompt.
 *
 * Interactive sessions block on a choice. Sessions without a
 * readline return an error the model can read and then continue.
 */
import type readline from "node:readline";
import * as p from "../ui/prompts.js";

export interface AskUserArgs {
  question?: string;
  options?: string[] | string;
}

export function normaliseAskOptions(raw: AskUserArgs["options"]): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }
  return [];
}

export async function answerAskUserQuestion(
  args: AskUserArgs,
  rl?: readline.Interface,
): Promise<string> {
  const question = (args.question ?? "").trim();
  const options = normaliseAskOptions(args.options);
  if (!question) {
    return `Error: ask_user_question requires a question.`;
  }
  if (options.length === 0) {
    return `Error: ask_user_question requires at least one option.`;
  }
  if (!rl) {
    return `Error: This session cannot ask the user. Proceed from the task, or state the assumption you are making.`;
  }

  if (rl) rl.pause();
  try {
    const choice = await p.select({
      message: question,
      options: options.map((label) => ({ value: label, label })),
      initialValue: options[0],
    });
    if (p.isCancel(choice) || typeof choice !== "string") {
      return `Error: The user dismissed the question. Proceed from the task, or state the assumption you are making.`;
    }
    return choice;
  } finally {
    rl.resume();
  }
}
