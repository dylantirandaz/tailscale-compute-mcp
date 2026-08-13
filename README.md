# Tailscale Compute MCP

Run builds, tests, and benchmarks on your own remote compute node from an MCP coding agent.

The coding agent edits files on your local computer. This MCP server copies the project through `rsync` and runs a command through SSH only when the agent calls `compute_run`.

This is an independent project. It is not an official Tailscale product and is not endorsed by Tailscale Inc. Tailscale is a trademark of Tailscale Inc.

## Release status

This package is a beta.

- The full path has run on a Mac laptop and an Apple M4 Mac mini.
- The server includes Linux probes and NVIDIA inventory support.
- Linux parsing has automated coverage.
- This release has not run on a real NVIDIA DGX Spark. Do not treat the Linux or NVIDIA result as DGX Spark validation yet.

## How it works

```text
MCP coding agent
    |
    | local stdio
    v
Tailscale Compute MCP
    |
    | rsync and SSH through the user's tailnet
    v
Mac or Linux compute node
```

The package runs on the local computer. No MCP service runs on the remote node. The project author does not receive your code, credentials, command output, or Tailscale traffic.

## Security warning

`compute_run` can run any non-interactive command with the permissions of the remote SSH user. Treat it as remote code execution.

- Use a dedicated non-root account on the remote node.
- `compute_status` reports the remote user id and warns when the SSH user is root. Run compute through a non-root user so a compromised build cannot control the whole node.
- Every `compute_run` is recorded in a local audit log (program, arguments, workspace, and result). It never contains environment values, standard input, or credentials.
- Do not auto-approve `compute_run` calls.
- Do not put passwords, SSH private keys, or Tailscale auth keys in MCP configuration.
- Use an SSH agent or Tailscale SSH.
- Limit access with Tailscale policy rules.
- Review [`SECURITY.md`](SECURITY.md) before use.

## Requirements

### Local computer

- Node.js 20 or later.
- Tailscale connected to the same tailnet as the remote node.
- OpenSSH client.
- `rsync` with filter support.
- An MCP host that supports local stdio servers.

macOS and Linux are the supported local systems for this beta.

### Remote node

- Darwin or Linux.
- Tailscale connected.
- SSH server.
- `rsync` available on `PATH`.
- A known SSH host key.
- The toolchain required by the project.

The MCP package does not need Node.js on the remote node unless the remote workload uses Node.js.

## Set up a Mac mini

1. Install and connect Tailscale on both Macs.
2. On the Mac mini, open **System Settings**, select **General**, select **Sharing**, and turn on **Remote Login**.
3. Add the local public key to the remote account:

```sh
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@mac-mini.example.ts.net
```

4. Verify the host key and non-interactive access:

```sh
ssh user@mac-mini.example.ts.net /usr/bin/true
```

5. Check the remote tools:

```sh
ssh user@mac-mini.example.ts.net '/bin/zsh -lc "rsync --version"'
```

A sleeping or powered-off Mac might not accept a Tailscale connection. Configure macOS network wake when required. This MCP server does not send wake packets.

## Set up a Linux node

Install and connect Tailscale by using the official Tailscale instructions for your Linux distribution. Then install an SSH server and `rsync`.

For Ubuntu or Debian:

```sh
sudo apt-get update
sudo apt-get install --yes openssh-server rsync
sudo systemctl enable --now ssh
```

Use a standard SSH key:

```sh
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@compute-node.example.ts.net
ssh user@compute-node.example.ts.net /usr/bin/true
```

You can use Tailscale SSH on supported Linux nodes instead of distributing SSH keys. Your Tailscale policy must permit both the network connection and SSH connection.

## Install in an MCP host

Pin the package version. Do not use an unpinned package for agent command execution.

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "tailscale-compute": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2"
      ],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "user@compute-node.example.ts.net"
      }
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tailscale-compute": {
      "command": "npx",
      "args": [
        "-y",
        "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2"
      ],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "user@compute-node.example.ts.net"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add tailscale-compute \
  -e TAILSCALE_COMPUTE_HOST=user@compute-node.example.ts.net \
  -- npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2
```

## Check the connection

Run the package outside the MCP host first:

```sh
TAILSCALE_COMPUTE_HOST=user@compute-node.example.ts.net \
npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2 --check
```

A successful check returns `kind: "ready"`. It also reports:

- Operating system.
- CPU architecture and model.
- Logical processor count.
- Memory.
- Selected remote shell.
- `rsync` version.
- NVIDIA GPU inventory when `nvidia-smi` is available.

## MCP tools

### `compute_status`

Checks SSH access and reports the remote platform and hardware.

### `compute_run`

Copies the local workspace and runs one non-interactive remote command.

Example:

```json
{
  "program": "npm",
  "arguments": ["test"],
  "syncMode": "incremental",
  "timeoutSeconds": 900
}
```

For shell syntax, call a supported remote shell explicitly:

```json
{
  "program": "/bin/bash",
  "arguments": ["-lc", "npm ci && npm test"],
  "syncMode": "clean",
  "timeoutSeconds": 1800
}
```

`compute_run` returns the remote exit code, standard output, standard error, sync time, and command time. Output is limited to protect the MCP connection. When output is too large, the result keeps its start and end and reports the omitted byte count.

## Sync modes

- `incremental`: Update the managed remote workspace and delete remote files that no longer exist locally.
- `clean`: Delete only the hashed managed workspace, create it again, and copy the project.
- `none`: Reuse the last remote snapshot without copying local files.

Each local workspace maps to a stable remote directory under:

```text
.cache/tailscale-compute-mcp
```

The server runs commands for one workspace in sequence. Different workspaces can run at the same time.

## Excluded files

The sync reads `.gitignore` and `.tailscale-compute-ignore` files. It also excludes these patterns by default:

```text
.git/
.env
.env.*
.npmrc
.pypirc
.ssh/
.aws/
.gnupg/
.git-credentials
.netrc
*_history
.curlrc
.wgetrc
*.pem
*.key
*.p12
*.pfx
*.secret
secrets/
node_modules/
.venv/
venv/
target/
__pycache__/
.next/cache/
```

Add project-specific secrets and large outputs to `.tailscale-compute-ignore`.

Ignored files are not copied. If a required file is ignored, create it on the remote node or provide its value through an explicit `compute_run.environment` entry. Remember that tool arguments are visible to the MCP host and model.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TAILSCALE_COMPUTE_HOST` | Yes | None | SSH user and direct Tailscale IP address or full MagicDNS name. |
| `TAILSCALE_COMPUTE_LOCAL_ROOT` | No | MCP process directory | Absolute local project path. |
| `TAILSCALE_COMPUTE_REMOTE_ROOT` | No | `.cache/tailscale-compute-mcp` | Managed remote workspace root. |
| `TAILSCALE_COMPUTE_REMOTE_SHELL` | No | `auto` | `auto`, `/bin/sh`, `/bin/bash`, or `/bin/zsh`. |
| `TAILSCALE_COMPUTE_CONNECT_TIMEOUT_SECONDS` | No | `10` | SSH connection timeout from 1 through 60 seconds. |
| `TAILSCALE_COMPUTE_AUDIT_LOG` | No | `~/.config/tailscale-compute-mcp/compute-audit.log` | Local audit log path for `compute_run` records. |

Automatic shell selection uses `/bin/zsh` on Darwin. It uses `/bin/bash` on Linux when available and `/bin/sh` otherwise.

## Multiple compute nodes

Register the package more than once with a different name and host. Keep one target per MCP server instance.

```json
{
  "mcpServers": {
    "compute-mac-mini": {
      "command": "npx",
      "args": ["-y", "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2"],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "developer@mac-mini.example.ts.net"
      }
    },
    "compute-linux": {
      "command": "npx",
      "args": ["-y", "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.2"],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "developer@linux-node.example.ts.net",
        "TAILSCALE_COMPUTE_REMOTE_SHELL": "/bin/bash"
      }
    }
  }
}
```

## NVIDIA workloads

`compute_status` reports NVIDIA devices through `nvidia-smi`. This inventory does not prove that a workload used a GPU.

A GPU workload must select the intended device and verify the placement of its model, inputs, computation, and outputs. Do not treat a successful `nvidia-smi` call as functional validation. The server does not fall back to CPU on behalf of the remote command.

## Development

```sh
npm ci
npm run check
```

Run a connection check against a real remote node:

```sh
TAILSCALE_COMPUTE_HOST=user@100.64.0.1 node dist/main.js --check
```

Test the package contents before release:

```sh
npm pack --dry-run
```

## License

MIT. See [`LICENSE`](LICENSE).
