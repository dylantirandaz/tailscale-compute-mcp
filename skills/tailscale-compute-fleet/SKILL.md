---
name: tailscale-compute-fleet
description: Select Tailscale Compute nodes for independent jobs and run declared multi-node workflows without hidden scheduling or hardware fallback.
managedBy: "@dylantirandaz/tailscale-compute-mcp"
---

# Tailscale Compute Fleet

Use this skill when two or more MCP servers expose Tailscale Compute tools.
Each MCP server controls one node. The MCP server does not pool CPU, GPU, or
memory. It does not make a command distributed.

## Invariants

- Keep one named MCP server for each node.
- An explicit user target overrides each placement rule.
- Refuse a node that does not meet the platform, architecture, memory,
  accelerator, or toolchain requirements of the command.
- Never replace a requested accelerator with a CPU or another backend.
- Never use a hidden queue. Return a node-busy result or select a different
  eligible node explicitly.
- Use the distributed runtime that the repository declares. Do not install or
  infer a runtime only to distribute a command.
- Do not claim that memory or accelerator resources are combined across Macs.
- Keep the control connection on the Tailscale address. Use a Thunderbolt data
  path only when the project supplies or requests a valid runtime host file.

## Independent job placement

1. Identify each available MCP server that exposes `compute_status` and
   `compute_job_start`.
2. Call `compute_status` on each node. Reject unavailable nodes and nodes with
   incompatible hardware or operating systems.
3. Call `compute_job_list` for active states when current durable-job load is
   not available.
4. Build the task dependency graph. Send only independent tasks to different
   nodes at the same time.
5. Select the eligible node with the lowest active-job count. Then use the
   lowest reported load. Use the MCP server name as the stable final
   tie-breaker.
6. Start each task with a stable `idempotencyKey`, a workflow label, and each
   required `artifactPath`.
7. Record the selected MCP server name and returned job ID. Poll, cancel,
   delete, and fetch through that same server.
8. Fetch immutable artifacts by job ID. Check each fetched SHA-256 value
   against the terminal receipt before a dependent task uses the files.

Do not move an active durable job between nodes. A retry must use the same MCP
server and the same request data. This lets idempotency return the first job.

## One program across several nodes

Use this mode only when the repository or user identifies a distributed entry
point and runtime, such as MLX distributed, Ray, or MPI. An ordinary Python,
shell, build, or test command is not a distributed program.

1. Read the repository launch instructions and runtime configuration. Do not
   create a second convention.
2. Select nodes that meet the same runtime, architecture, dependency, and
   network requirements.
3. Synchronize the same workspace revision to each selected node. Run the
   existing runtime preflight on each node and compare versions.
4. Use Tailscale names for SSH control. Use data-plane addresses from the
   project host file. For MLX, a declared Thunderbolt ring or JACCL host file
   can use Thunderbolt addresses or RDMA devices.
5. Start the declared coordinator or launcher command as a durable job. Start
   separate worker jobs only when the runtime contract requires them.
6. Keep a workflow table with each node name, role, job ID, state, and artifact
   owner. On failure or cancellation, cancel each active job in that table. Do
   not assume that coordinator cancellation stopped remote workers. Verify each
   worker state.
7. Require evidence that each rank joined. Check the world size, rank-to-node
   mapping, backend, device placement, and a result that depends on all ranks.
8. Fetch declared artifacts only from their owning jobs. Check terminal
   receipts and hashes before you report success.

### Runtime rules

- **MLX distributed:** Use the repository `mlx.launch` command and host file.
  Prefer its ring backend for a declared TCP or Thunderbolt ring. Use JACCL only
  when each selected Mac meets the macOS, Thunderbolt, RDMA, and topology
  requirements.
- **Ray:** Use an existing Ray cluster entry point. Ray task placement does not
  prove that Apple GPU memory or model state is distributed.
- **MPI:** Use an existing MPI-aware program and host file. Starting a normal
  process with `mpirun` does not make its computation distributed.

## Verification report

Report:

- The selected MCP server and physical node for each task or rank.
- The operating system, architecture, relevant accelerator, and runtime
  version.
- Job IDs, labels, idempotency keys, and terminal states.
- The runtime backend and data-plane network for a multi-node program.
- Rank count and placement checks.
- The meaningful output or invariant that you checked.
- Artifact paths and verified SHA-256 values.
- Each node, rank, accelerator, or cleanup path that did not run or did not
  pass.
