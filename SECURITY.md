# Security Policy

## Report a vulnerability

Use a private GitHub security advisory for the repository:

```text
https://github.com/dylantirandaz/tailscale-compute-mcp/security/advisories/new
```

Do not report credentials, private keys, private hostnames, tailnet details, or an active exploit in a public issue.

Include:

- Affected package version.
- Local and remote operating systems.
- A minimal reproduction.
- Expected and actual behavior.
- The security effect.

## Security model

This package runs locally as an MCP stdio server. It uses the local `ssh` and `rsync` programs to access one configured node in the user's Tailscale network.

The package does not provide:

- A hosted control service.
- A public HTTP endpoint.
- SSH credentials.
- Tailscale credentials.
- A remote privilege boundary.
- A command sandbox.

`compute_run` has the full permissions of the configured remote SSH user. A successful attack against the MCP host, coding agent, package, or remote account can run commands and read files available to that user.

## Required user controls

1. Use a dedicated non-root remote user for `compute_run`. The server reports the remote user id and warns in `compute_status` and `compute_run` results when the SSH user is root (uid 0). A root compute user removes the last privilege boundary on the remote node.
2. Limit the source and destination with Tailscale policy rules.
3. Use an SSH agent or Tailscale SSH. Do not place private keys or passwords in MCP configuration.
4. Verify the SSH host key before the first MCP call.
5. Keep `StrictHostKeyChecking` enabled.
6. Require approval for `compute_run`.
7. Review command arguments before approval.
8. Add project secrets to `.gitignore` or `.tailscale-compute-ignore`.
9. Review remote command output before sending it to another system.
10. Treat the local audit log as sensitive. It records every `compute_run` and can reveal project layout and command history.
11. Remove access when a local or remote device is lost.

## Audit log

Every `compute_run` that reaches the workspace is appended as one JSON line to a local audit log. The default path is:

```text
~/.config/tailscale-compute-mcp/compute-audit.log
```

Set `TAILSCALE_COMPUTE_AUDIT_LOG` to use a different path. Each record contains the timestamp, target, remote workspace, program, arguments, working directory, sync mode, and outcome. It never contains environment variable values, standard input, or credentials. New audit directories use mode `0700`, and new audit files use mode `0600`. Existing paths keep their current permissions. The audit log cannot prevent abuse; it provides a trail for review after a compromise. Protect it from readers who should not see command history.

## File synchronization

The package uses `rsync --delete` only inside a stable, hashed workspace under the configured remote root. `clean` mode removes that hashed workspace before it copies the project.

The default remote root is:

```text
.cache/tailscale-compute-mcp
```

Do not set the remote root to a directory that contains unrelated data.

The package reads `.gitignore` and `.tailscale-compute-ignore` only from the workspace root. It converts simple rules to inline rsync include and exclude patterns for macOS and Linux. Fixed exclusions have priority over ignore-file negation. The package also excludes common secret-file patterns and per-user credential directories, including `.ssh/`, `.aws/`, `.gnupg/`, `.netrc`, `.git-credentials`, shell histories, and key and certificate files. These rules cannot identify every secret. The user remains responsible for the files in the local project. In particular, never point `workspacePath` at a home directory or other broad root, because unknown secret files could still match.

## Command output

Standard output and standard error return to the MCP host and can become model context. A remote command can print tokens, credentials, source code, or personal data. Do not run commands that print secrets.

## Network boundary

The target parser accepts only:

- Tailscale IPv4 addresses in `100.64.0.0/10`.
- Tailscale IPv6 addresses under `fd7a:115c:a1e0::/48`.
- Full names that end in `.ts.net`.

IPv6 destinations must use square brackets. The parser rejects port suffixes, CIDR suffixes, SSH options, and whitespace in the destination.

This check reduces accidental use on the public internet. It does not replace Tailscale policy rules or SSH authorization.

## Accelerator workloads

NVIDIA inventory is informational. It does not prove that a command used the intended GPU. A workload must fail when its required accelerator is missing or wrong. Do not accept CPU execution as proof for a requested GPU workload.

## Supported versions

Only the newest beta version receives security fixes before version 1.0. After version 1.0, this policy will list supported stable release lines.
