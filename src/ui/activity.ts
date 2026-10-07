/**
 * One place for transient status while a task is running.
 * The loader registers a sink and paints the line in place.
 * With no sink, the line is printed once.
 */
type ActivitySink = (line: string) => void;

let sink: ActivitySink | null = null;

export function setActivitySink(next: ActivitySink | null): void {
  sink = next;
}

export function reportActivity(line: string): void {
  if (sink) {
    sink(line);
    return;
  }
  console.log(line);
}
