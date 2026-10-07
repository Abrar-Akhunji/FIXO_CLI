/**
 * Last-line contract shared by one-shot runs.
 * `done` exits 0. `incomplete: …` and `plan-only` exit 1.
 */
export function headlessStatusLine(result: {
  success: boolean;
  response: string;
}): string {
  if (result.success) return "done";
  const first = (result.response ?? "").split("\n")[0]?.trim() ?? "";
  if (first === "plan-only" || first.startsWith("incomplete:")) return first;
  if (!first) return "incomplete: task failed";
  return `incomplete: ${first}`;
}

export function headlessExitCode(success: boolean): 0 | 1 {
  return success ? 0 : 1;
}
