/** Extract the exact store description; never normalize its whitespace.
 * @param {string} copy
 * @returns {string}
 */
export function extractCwsDescription(copy) {
  const start = "<!-- description:start -->";
  const end = "<!-- description:end -->";
  if (copy.split(start).length !== 2 || copy.split(end).length !== 2) {
    throw new Error("Exactly one description marker pair is required.");
  }
  const description = copy.match(
    /<!-- description:start -->\n([\s\S]+?)\n<!-- description:end -->/,
  )?.[1];
  if (!description?.trim() || description.length > 16000) {
    throw new Error(
      "A non-empty description of at most 16000 characters is required between ordered markers.",
    );
  }
  return description;
}
