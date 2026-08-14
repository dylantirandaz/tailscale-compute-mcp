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
- Command starts, artifact fetches, and successful workspace deletions are recorded in a local audit log. The log never contains environment values, standard input, or credentials.
- Do not auto-approve command, fetch, cancel, or deletion tools.
- Do not put passwords, SSH private keys, or Tailscale auth keys in MCP configuration.
- Use an SSH agent or Tailscale SSH.
- Limit access with Tailscale policy rules.
- Review [`SECURITY.md`](SECURITY.md) before use.

## Requirements

### Local computer

- Node.js 20 or later.
- Tailscale connected to the same tailnet as the remote node.
- OpenSSH client.
- `rsync` with `--include` and `--exclude` support.
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

### Oh My Pi (OMP)

Run the safe setup command for the default OMP profile:

```sh
npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5 \
  setup omp \
  --host user@compute-node.example.ts.net
```

The command prints the MCP configuration path and the fleet skill path. It
runs the real SSH connection check before it writes a file. It then adds
`tailscale-compute` to `~/.omp/agent/mcp.json` and installs the managed
`tailscale-compute-fleet` skill in `~/.omp/agent/skills/`. It preserves other
servers, pins this package version, and uses atomic file replacement.

The command does not write a file when the connection check fails. It refuses
malformed JSON, symbolic links, a server name with different settings, and an
unmanaged skill with the same name.

For a named profile, manually merge the server entry into
`~/.omp/profiles/<name>/agent/mcp.json` and install the skill in that profile's
`skills/tailscale-compute-fleet/` directory. Keep all existing server entries:

```json
{
  "mcpServers": {
    "tailscale-compute": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5"
      ],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "user@compute-node.example.ts.net"
      }
    }
  }
}
```

Replace the example host with the SSH user and the Tailscale IP address or
full MagicDNS name of your compute node.

Start a new OMP session after setup. OMP then loads the server and advertises
the fleet skill to the agent automatically. In an existing session,
`/mcp reload` loads the server, but the new skill becomes available in the
next session. Test the server after reload or restart:

```text
/mcp test tailscale-compute
```

Print a pinned configuration for Claude Code, Cursor, Codex, or OpenCode:

```sh
npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5 \
  setup print --client <claude|cursor|codex|opencode> \
  --host user@compute-node.example.ts.net
```

The Claude output is a user-scoped command. The Cursor and OpenCode outputs
are JSON. The Codex output is TOML for `~/.codex/config.toml`. Merge JSON or
TOML output with an existing client configuration instead of replacing
unrelated entries.

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
        "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5"
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
        "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5"
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
claude mcp add --scope user \
  --env TAILSCALE_COMPUTE_HOST=user@compute-node.example.ts.net \
  --transport stdio tailscale-compute \
  -- npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5
```

## Check the connection

Run the package outside the MCP host first:

```sh
TAILSCALE_COMPUTE_HOST=user@compute-node.example.ts.net \
npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5 --check
```

A successful check returns `kind: "ready"`. It also reports:

- Operating system.
- CPU architecture and model.
- Logical processor count.
- Memory.
- Selected remote shell.
- `rsync` version.
- NVIDIA GPU inventory when `nvidia-smi` is available.
- Live uptime, load averages, available memory, storage capacity, active durable job count, and NVIDIA memory and utilization.

## MCP tools

### `compute_status`

Checks SSH access and reports the remote platform, hardware, and live health.

Installed GPU memory stays in `hardware.acceleratorInventory`. Current GPU
memory use, available memory, and utilization stay in
`health.acceleratorUsage`.

### `compute_doctor`

Runs the explicit `pytorch` profile with one selected Python program on one
required logical CUDA device:

```json
{
  "profile": "pytorch",
  "pythonProgram": "/opt/project/.venv/bin/python",
  "requiredDevice": "cuda:0",
  "minimumAvailableMemoryBytes": 24000000000
}
```

The selected Python program must contain PyTorch with CUDA support. The remote
node must also provide `nvidia-smi`. The profile reports the NVIDIA driver, the
PyTorch CUDA runtime, optional `nvcc` compiler, cuDNN, compute capability,
available memory, dtype, and relevant backend flags. It runs a known
`torch.float32` linear operation and verifies its result. It also verifies that
the model, input, intermediate value, and output stay on the required device. A
missing requirement returns `check_failed`; the profile never selects a
different GPU or falls back to the CPU.

The doctor proves only its small operation. Run the real workload and check
its outputs before you claim application support.

### `compute_workspace_status`

Reports the managed remote path, disk usage, last successful sync, last run
request, and active durable job IDs for one local workspace.

### `compute_workspace_delete`

Deletes only the managed remote directory that maps to one local workspace.
It refuses deletion while a durable job is active. A repeated delete succeeds
and reports `existed: false`.

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

### Hardware requirements

`compute_run` and `compute_job_start` accept an optional `requirements`
object. The server checks these requirements against the remote hardware
before it starts the workload. It returns `kind: "requirements_not_met"` and
does not sync or start the command when a requirement fails.

```json
{
  "program": "python",
  "arguments": ["train.py"],
  "requirements": {
    "platform": "linux",
    "architecture": "x86_64",
    "minimumMemoryBytes": 34359738368,
    "nvidia": {
      "minimumDeviceCount": 1,
      "minimumMemoryBytesPerDevice": 24000000000
    }
  }
}
```

The server does not select a device and does not fall back to the CPU. The
workload must select and verify its required accelerator.

### Durable jobs

`compute_job_start` syncs the workspace and starts a detached command. It
returns a job ID after the remote launcher starts. The command continues when
the MCP client disconnects.

```json
{
  "program": "python",
  "arguments": ["train.py"],
  "syncMode": "incremental",
  "timeoutSeconds": 43200,
  "idempotencyKey": "training-run-2026-08-14",
  "label": "baseline",
  "artifactPaths": ["checkpoints/final.pt", "metrics/results.json"]
}
```

- `compute_job_status` returns `starting`, `running`, `completed`, `failed`,
  `cancelled`, or `lost`.
- `compute_job_logs` reads `stdout` or `stderr` from an exact byte offset. Use
  `nextOffsetBytes` in the next call. `endOfStream` becomes true after the job
  reaches a terminal state and the returned offset reaches the file size.
- `compute_job_cancel` stops the remote process group. A terminal job returns
  its existing terminal state.
- `compute_job_list` returns a filtered, paged list with job IDs, states,
  labels, programs, workspace paths, times, and terminal results.
- `compute_job_delete` deletes only a terminal job. It refuses active jobs and
  unsafe remote job directories.

Each terminal job state includes output byte counts and SHA-256 digests.

An idempotency key is scoped to the target and workspace. A retry with the
same request returns the existing job. Reuse with a different request returns
`idempotency_conflict`.

After the command ends, declared artifact paths are copied into an immutable
job snapshot. The terminal status contains the updated receipt, which records
each regular file path, size, and SHA-256 digest. Workspace synchronization
does not delete these snapshots.

Terminal results classify a normal exit, signal, timeout, cancellation, lost
job, or out-of-memory termination. The server reports out-of-memory only when
the process exit and Linux cgroup memory event evidence agree.

Set `TAILSCALE_COMPUTE_MAX_ACTIVE_JOBS` to enforce one node-wide limit across
all workspaces and MCP server processes that use the same remote root. Job
admission uses an atomic remote reservation. A full node returns `node_busy`
with the configured limit, active job IDs, and the number of starts that are
still in admission. It does not queue or start the refused job.

### `compute_fetch`

Fetches selected files or directories from the managed remote workspace to a
local destination under the local workspace.

```json
{
  "paths": ["benchmark/results.json"],
  "localDestination": ".tailscale-compute-results/latest",
  "overwrite": false
}
```

To fetch every declared artifact from an immutable terminal job snapshot,
include its job ID and omit `paths`:

```json
{
  "jobId": "12345678-1234-4234-8234-123456789abc",
  "localDestination": ".tailscale-compute-results/baseline",
  "overwrite": false
}
```

Set `paths` with a job ID to fetch only selected declared artifacts. The tool
refuses remote symbolic links, destination escapes, undeclared job artifacts,
and an existing destination unless `overwrite` is true. It reports the size
and SHA-256 digest of each fetched regular file. A job fetch also checks every
downloaded file against the immutable job receipt.

### Run receipts

Each run and durable job has a structured receipt. It records the run ID,
server version, local Git revision, command arguments, environment variable
names, sync mode, reported hardware, timing, result, output digests, and
fetched artifacts. A durable receipt can also contain its label, exhaustive
termination result, and immutable artifact manifest. It does not record
environment values, standard input, or an idempotency key. Durable jobs store
the receipt in the remote job directory and update it when the job reaches a
terminal state.

## Sync modes

- `incremental`: Update the managed remote workspace and delete remote files that no longer exist locally.
- `clean`: Delete only the hashed managed workspace, create it again, and copy the project.
- `none`: Reuse the last remote snapshot without copying local files.

Each local workspace maps to a stable remote directory under:

```text
.cache/tailscale-compute-mcp
```

The server runs commands for one workspace in sequence. Different workspaces can run at the same time.

`compute_workspace_status` reports `lastSyncAt: { "kind": "never" }` or
`lastRunAt: { "kind": "never" }` until the related event occurs.

## Excluded files

The sync reads `.gitignore` and `.tailscale-compute-ignore` from the workspace root. It supports blank lines, comments that start with `#`, negation that starts with `!`, and standard rsync patterns. It does not read nested ignore files. Each ignore file can be up to 64 KiB, and the server reads up to 5,000 rules across both files. It ignores a file or later rules that exceed these limits.

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

The fixed exclusions above have priority. An ignore-file negation cannot include one of these files.

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
| `TAILSCALE_COMPUTE_MAX_ACTIVE_JOBS` | No | No limit | Node-wide durable job limit from 1 through 1024. |
| `TAILSCALE_COMPUTE_AUDIT_LOG` | No | `~/.config/tailscale-compute-mcp/compute-audit.log` | Local audit log path for `compute_run` records. |

Automatic shell selection uses `/bin/zsh` on Darwin. It uses `/bin/bash` on Linux when available and `/bin/sh` otherwise.

## Multiple compute nodes

For OMP, run setup once for each node and give each server a unique name:

```sh
npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5 \
  setup omp \
  --host developer@first-mini.example.ts.net \
  --name compute-mac-mini-1

npx -y @dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5 \
  setup omp \
  --host developer@second-mini.example.ts.net \
  --name compute-mac-mini-2
```

Each command checks its node and preserves the other named servers. The first
command installs the fleet skill. Later commands reuse or update that managed
skill. Start a new OMP session after the last command.

For other MCP clients, register the package more than once with a different
name and host. Keep one target per MCP server instance.

```json
{
  "mcpServers": {
    "compute-mac-mini": {
      "command": "npx",
      "args": ["-y", "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5"],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "developer@mac-mini.example.ts.net"
      }
    },
    "compute-linux": {
      "command": "npx",
      "args": ["-y", "@dylantirandaz/tailscale-compute-mcp@0.1.0-beta.5"],
      "env": {
        "TAILSCALE_COMPUTE_HOST": "developer@linux-node.example.ts.net",
        "TAILSCALE_COMPUTE_REMOTE_SHELL": "/bin/bash"
      }
    }
  }
}
```

### Agent-controlled workflows

For independent work, let the agent query `compute_status` and
`compute_job_list` on each named MCP server. The agent can select an eligible
node by platform, architecture, hardware requirements, active-job count, and
load. A retry must use the same server, idempotency key, and request data.
Artifacts remain owned by the selected node and must move through
`compute_fetch` with receipt hash verification.

The package does not include a fleet scheduler or hidden queue. It also does
not turn an ordinary command into a distributed program. A program can use
several nodes only when the project declares a distributed runtime and launch
command, such as MLX distributed, Ray, or MPI. Synchronize the same workspace
revision and runtime version to every node before launch. Record every node
role and job ID, and verify every worker state during cancellation or cleanup.

A Thunderbolt cable supplies a possible data-plane network between Macs. It
does not combine their CPU, GPU, or unified memory. Keep MCP control
connections on Tailscale and use Thunderbolt addresses only through the
declared runtime configuration.

MLX provides `mlx.launch` for SSH-connected hosts, a TCP or Thunderbolt ring
backend, and JACCL for supported Thunderbolt RDMA systems. Use the
[official MLX distributed guide](https://ml-explore.github.io/mlx/build/html/usage/distributed.html)
for its host-file, topology, operating-system, and RDMA requirements. A
distributed validation must check the world size, rank placement, backend,
device placement, and a result that depends on every rank.

## NVIDIA workloads

`compute_status` reports NVIDIA devices through `nvidia-smi`. This inventory
does not prove that a workload used a GPU. `compute_doctor` proves one small
PyTorch operation and exact CUDA placement on the selected device, but it does
not prove an application workload.

A GPU workload must select the intended device, verify the placement of its
model, inputs, computation, and outputs, and check a meaningful result. The
server does not fall back to the CPU on behalf of a remote command.

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
