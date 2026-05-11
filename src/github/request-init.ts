export function withOptionalSignal(
  init: Omit<RequestInit, "signal">,
  signal?: AbortSignal,
): RequestInit {
  return signal == null ? init : { ...init, signal };
}
