/**
 * Parse the completion markers emitted around one persistent-shell command.
 * This deliberately uses string boundaries instead of dynamically-built
 * regular expressions so marker text and chunk boundaries cannot corrupt parsing.
 */
export function parseShellOutput(output, startMarker, endMarker, cwdMarker) {
  const startAt = output.indexOf(startMarker);
  if (startAt < 0) return null;

  const endAt = output.indexOf(endMarker + ":", startAt + startMarker.length);
  if (endAt < 0) return null;

  const exitStart = endAt + endMarker.length + 1;
  const exitEnd = output.indexOf("\n", exitStart);
  if (exitEnd < 0) return null;
  const exitText = output.slice(exitStart, exitEnd).replace(/\r$/, "");
  if (!/^-?\d+$/.test(exitText)) return null;

  const cwdAt = output.indexOf(cwdMarker, exitEnd + 1);
  if (cwdAt < 0) return null;
  const cwdEnd = output.indexOf("\n", cwdAt);
  if (cwdEnd < 0) return null;
  const cwd = output.slice(cwdAt + cwdMarker.length, cwdEnd).replace(/\r$/, "").trim();
  if (!cwd) return null;

  let stdout = output.slice(startAt + startMarker.length, endAt);
  stdout = stdout.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return { stdout, exitCode: Number(exitText), cwd };
}
