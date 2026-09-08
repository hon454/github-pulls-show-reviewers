import { getUIClient } from "./ui-client";
import {
  preferencePatchSchema,
  type PreferencePatch,
} from "../shared/preferences";
export { DEFAULT_PREFERENCES, type Preferences } from "../shared/preferences";

export async function getPreferences() {
  return (await getUIClient().read()).preferences;
}
export function updatePreferences(patch: PreferencePatch) {
  return getUIClient().patchPreferences({
    type: "patchPreferences",
    patch: preferencePatchSchema.parse(patch),
  });
}
