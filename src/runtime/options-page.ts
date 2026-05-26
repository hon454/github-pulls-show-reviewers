import { z } from "zod";

export const openOptionsPageMessageSchema = z.object({
  type: z.literal("openOptionsPage"),
}).strict();

export type OpenOptionsPageMessage = z.infer<
  typeof openOptionsPageMessageSchema
>;

export function isOpenOptionsPageMessage(
  value: unknown,
): value is OpenOptionsPageMessage {
  return openOptionsPageMessageSchema.safeParse(value).success;
}
