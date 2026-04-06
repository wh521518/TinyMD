const TASK_LIST_DEBUG_PATTERN =
  /(?:^\s*(?:[-+*]|\d+\.)\s+(?:\\?\[[ xX]\](?:\s*<br\s*\/?>)?))/m;

export const hasTaskListDebugSignal = (text: string) => TASK_LIST_DEBUG_PATTERN.test(text);

export const logTaskListDebug = (
  stage: string,
  before: string,
  after: string,
  extra?: Record<string, unknown>,
) => {
  if (!import.meta.env.DEV) {
    return;
  }

  if (before === after && !hasTaskListDebugSignal(before) && !hasTaskListDebugSignal(after)) {
    return;
  }

  console.info("[tinymd:tasklist-debug]", {
    stage,
    changed: before !== after,
    before,
    after,
    ...extra,
  });
};

export const normalizeTaskListMarkdown = (text: string) => {
  logTaskListDebug("normalize", text, text);
  return text;
};
