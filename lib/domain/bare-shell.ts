// 毛坯还原 jobs ride the existing editInstruction channel (like local-edit tokens),
// so the job schema, queue work contract and consumer stay unchanged. Anything that
// reads editInstruction as user text must go through userEditInstruction().
export const BARE_SHELL_INSTRUCTION = "bare-shell:v1";
export const BARE_SHELL_PROMPT_TEMPLATE_VERSION = "bare-shell-v1";

export function isBareShellInstruction(value: unknown): boolean {
  return value === BARE_SHELL_INSTRUCTION;
}

/** The editInstruction as user-meaningful text, or null when it is only a mode token. */
export function userEditInstruction(value: string | null | undefined): string | null {
  return value && !isBareShellInstruction(value) ? value : null;
}
