/* Interactive claude processes report a status in ~/.claude/sessions/<pid>.json:
 * "idle" when waiting at the prompt, "busy" while the model works, "shell" while
 * a tool command runs. Anything that isn't idle counts as working. */
export const terminalBusy = (status: string | undefined | null) => Boolean(status) && status !== "idle" && status !== "unknown";
