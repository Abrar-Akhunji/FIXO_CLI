import {
  createBranch,
  commitChanges,
  pushBranch,
  createPullRequest,
} from "../../git/git-ops.js";
import type { ToolExecutionOptions } from "./types.js";

export async function executeCreateBranch(
  args: { branchName: string },
  cwd: string,
): Promise<string> {
  if (!args.branchName) return "Error: branchName is required.";
  return createBranch(cwd, args.branchName);
}

export async function executeCommitChanges(
  args: { message: string },
  cwd: string,
): Promise<string> {
  if (!args.message) return "Error: message is required.";
  return commitChanges(cwd, args.message);
}

export async function executePushBranch(
  args: { remote?: string },
  cwd: string,
): Promise<string> {
  return pushBranch(cwd, args.remote || "origin");
}

export async function executeCreatePullRequest(
  args: { baseBranch?: string },
  cwd: string,
  options: ToolExecutionOptions = {},
): Promise<string> {
  if (!options.client) {
    throw new Error(
      "Agent client is required to generate pull request description",
    );
  }
  return await createPullRequest(
    cwd,
    options.client,
    options.model || "auto",
    args.baseBranch || "main",
  );
}
