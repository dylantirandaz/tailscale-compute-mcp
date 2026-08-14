import assert from "node:assert/strict";
import test from "node:test";

import { parseDoctorProtocol } from "../src/doctor.js";

const READY_REPORT = {
  kind: "ready",
  profile: "pytorch",
  backend: "cuda",
  device: "cuda:0",
  deviceName: "NVIDIA GeForce RTX 5090",
  physicalDevice: { kind: "uuid", uuid: "GPU-example" },
  pythonVersion: "3.12.3",
  pytorchVersion: "2.8.0+cu128",
  nvidiaDriverVersion: "575.64.03",
  cudaRuntimeVersion: "12.8",
  cudaCompiler: { kind: "installed", version: "12.8" },
  cudnnRuntime: { kind: "available", version: 91002 },
  driverRuntimeCompatible: true,
  computeCapability: { major: 12, minor: 0 },
  totalMemoryBytes: 34_179_940_352,
  availableMemoryBytes: 30_000_000_000,
  minimumAvailableMemoryBytes: 20_000_000_000,
  dtype: "torch.float32",
  backendFlags: { cudnnEnabled: true, matmulAllowTf32: false },
  placement: {
    model: "cuda:0",
    input: "cuda:0",
    intermediate: "cuda:0",
    output: "cuda:0",
  },
  operation: { kind: "linear_relu", outputSum: 56 },
} as const;

test("parses complete PyTorch CUDA doctor evidence", () => {
  const result = parseDoctorProtocol(JSON.stringify(READY_REPORT));

  assert.equal(result.ok, true);
  if (result.ok && result.value.kind === "ready") {
    assert.equal(result.value.driverRuntimeCompatible, true);
    assert.deepEqual(result.value.placement, READY_REPORT.placement);
    assert.equal(result.value.operation.outputSum, 56);
  }
});

test("rejects doctor output on a different CUDA device", () => {
  const result = parseDoctorProtocol(
    JSON.stringify({
      ...READY_REPORT,
      placement: { ...READY_REPORT.placement, output: "cuda:1" },
    }),
  );

  assert.equal(result.ok, false);
});

test("parses a doctor check failure as a value", () => {
  const result = parseDoctorProtocol(
    JSON.stringify({
      kind: "check_failed",
      profile: "pytorch",
      check: "pytorch_import",
      message: "No module named torch",
    }),
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "check_failed",
      profile: "pytorch",
      check: "pytorch_import",
      message: "No module named torch",
    },
  });
});
