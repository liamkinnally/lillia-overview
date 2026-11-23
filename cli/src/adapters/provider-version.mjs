// Only display numeric releases and recognized prerelease channels. Native
// command output can also contain paths, account details and control sequences.
const displayVersion =
  /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}(?:-(?:alpha|beta|rc)(?:\.(?:0|[1-9]\d{0,5})){0,3})?$/;

export function versionMismatch(provider, expected, observed) {
  let version;
  if (typeof observed === 'string' && observed.length <= 96) {
    if (provider === 'Claude Code')
      version = /^([^\s]+) \(Claude Code\)(?:\r?\n)?$/.exec(observed)?.[1];
    if (provider === 'Codex') version = observed;
  }
  const safe = version && displayVersion.exec(version)?.[0] === version ? version : 'unavailable';
  return (
    provider +
    ' profile requires verification: expected ' +
    expected +
    ', observed ' +
    safe +
    '. See docs/cli.md#reverify-a-provider-version.'
  );
}
