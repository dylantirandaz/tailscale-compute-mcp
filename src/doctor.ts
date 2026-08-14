import * as z from "zod/v4";

import { failure, success, type Result } from "./result.js";

export const cudaDeviceSchema = z
  .string()
  .regex(
    /^cuda:(0|[1-9]\d*)$/,
    "Select one logical CUDA device, such as cuda:0.",
  )
  .brand<"CudaDevice">();

export type CudaDevice = z.infer<typeof cudaDeviceSchema>;

export const doctorInputSchema = z.object({
  profile: z.literal("pytorch"),
  pythonProgram: z
    .string()
    .min(1)
    .max(4_096)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !value.includes("\r") &&
        !value.includes("\n"),
      "The Python program must not contain a null byte or a line break.",
    )
    .describe(
      "The Python executable or command for the environment that contains PyTorch.",
    ),
  requiredDevice: cudaDeviceSchema,
  minimumAvailableMemoryBytes: z.number().int().positive().optional(),
});

export type DoctorRequest = z.infer<typeof doctorInputSchema>;

export const doctorCheckSchema = z.enum([
  "python",
  "pytorch_import",
  "nvidia_driver",
  "cuda_runtime",
  "cuda_compiler",
  "device_selection",
  "device_memory",
  "gpu_operation",
  "output_placement",
]);

const cudaCompilerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not_installed") }),
  z.strictObject({
    kind: z.literal("installed"),
    version: z.string().min(1),
  }),
]);

const cudnnRuntimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not_available") }),
  z.strictObject({
    kind: z.literal("available"),
    version: z.number().int().positive(),
  }),
]);

const physicalDeviceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unavailable") }),
  z.strictObject({ kind: z.literal("uuid"), uuid: z.string().min(1) }),
]);

export const doctorReadyProtocolSchema = z.strictObject({
  kind: z.literal("ready"),
  profile: z.literal("pytorch"),
  backend: z.literal("cuda"),
  device: cudaDeviceSchema,
  deviceName: z.string().min(1),
  physicalDevice: physicalDeviceSchema,
  pythonVersion: z.string().min(1),
  pytorchVersion: z.string().min(1),
  nvidiaDriverVersion: z.string().min(1),
  cudaRuntimeVersion: z.string().min(1),
  cudaCompiler: cudaCompilerSchema,
  cudnnRuntime: cudnnRuntimeSchema,
  driverRuntimeCompatible: z.literal(true),
  computeCapability: z.strictObject({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
  totalMemoryBytes: z.number().int().positive(),
  availableMemoryBytes: z.number().int().positive(),
  minimumAvailableMemoryBytes: z.number().int().positive().optional(),
  dtype: z.literal("torch.float32"),
  backendFlags: z.strictObject({
    cudnnEnabled: z.boolean(),
    matmulAllowTf32: z.boolean(),
  }),
  placement: z.strictObject({
    model: cudaDeviceSchema,
    input: cudaDeviceSchema,
    intermediate: cudaDeviceSchema,
    output: cudaDeviceSchema,
  }),
  operation: z.strictObject({
    kind: z.literal("linear_relu"),
    outputSum: z.literal(56),
  }),
});

export const doctorCheckFailedProtocolSchema = z.strictObject({
  kind: z.literal("check_failed"),
  profile: z.literal("pytorch"),
  check: doctorCheckSchema,
  message: z.string().min(1),
});

export const doctorProtocolSchema = z.discriminatedUnion("kind", [
  doctorReadyProtocolSchema,
  doctorCheckFailedProtocolSchema,
]);

export type DoctorProtocol = z.infer<typeof doctorProtocolSchema>;
export type DoctorReadyProtocol = z.infer<typeof doctorReadyProtocolSchema>;
export type DoctorCheckFailedProtocol = z.infer<
  typeof doctorCheckFailedProtocolSchema
>;

export function parseDoctorProtocol(
  output: string,
): Result<DoctorProtocol, string> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(`The doctor output is not JSON: ${message}`);
  }
  const result = doctorProtocolSchema.safeParse(value);
  if (!result.success) {
    return failure(
      `The doctor output is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  if (result.data.kind === "ready") {
    const requestedDevice = result.data.device;
    if (
      Object.values(result.data.placement).some(
        (placementDevice) => placementDevice !== requestedDevice,
      )
    ) {
      return failure(
        "The doctor output placed work on a different CUDA device.",
      );
    }
  }
  return success(result.data);
}

export function buildPytorchDoctorScript(request: DoctorRequest): string {
  const device = JSON.stringify(request.requiredDevice);
  const minimumAvailableMemoryBytes =
    request.minimumAvailableMemoryBytes === undefined
      ? "None"
      : String(request.minimumAvailableMemoryBytes);
  return [
    "import json",
    "import re",
    "import shutil",
    "import subprocess",
    "import sys",
    "",
    `device_name = ${device}`,
    `minimum_available_memory_bytes = ${minimumAvailableMemoryBytes}`,
    "",
    "def fail(check, error):",
    "    message = str(error).strip() or error.__class__.__name__",
    "    print(json.dumps({\"kind\": \"check_failed\", \"profile\": \"pytorch\", \"check\": check, \"message\": message}, separators=(\",\", \":\")))",
    "    raise SystemExit(0)",
    "",
    "try:",
    "    import torch",
    "except Exception as error:",
    "    fail(\"pytorch_import\", error)",
    "",
    "try:",
    "    driver_process = subprocess.run([\"nvidia-smi\", \"--query-gpu=driver_version\", \"--format=csv,noheader,nounits\"], check=True, capture_output=True, text=True, timeout=10)",
    "    driver_versions = [line.strip() for line in driver_process.stdout.splitlines() if line.strip()]",
    "    if not driver_versions:",
    "        raise RuntimeError(\"nvidia-smi did not report an NVIDIA driver version.\")",
    "    driver_version = driver_versions[0]",
    "except Exception as error:",
    "    fail(\"nvidia_driver\", error)",
    "",
    "cuda_runtime_version = torch.version.cuda",
    "if not isinstance(cuda_runtime_version, str) or not cuda_runtime_version:",
    "    fail(\"cuda_runtime\", RuntimeError(\"PyTorch is not a CUDA build.\"))",
    "",
    "try:",
    "    if not torch.cuda.is_available():",
    "        raise RuntimeError(\"PyTorch cannot access the CUDA runtime.\")",
    "    device_index = int(device_name.split(\":\", 1)[1])",
    "    if device_index >= torch.cuda.device_count():",
    "        raise RuntimeError(f\"The requested {device_name} device is not available.\")",
    "    torch.cuda.set_device(device_index)",
    "    torch.cuda.init()",
    "except Exception as error:",
    "    fail(\"device_selection\", error)",
    "",
    "try:",
    "    properties = torch.cuda.get_device_properties(device_index)",
    "    available_memory_bytes, total_memory_bytes = torch.cuda.mem_get_info(device_index)",
    "    if available_memory_bytes <= 0:",
    "        raise RuntimeError(f\"The requested {device_name} device has no available memory.\")",
    "    if minimum_available_memory_bytes is not None and available_memory_bytes < minimum_available_memory_bytes:",
    "        raise RuntimeError(f\"The requested {device_name} device has {available_memory_bytes} available bytes, below the required {minimum_available_memory_bytes} bytes.\")",
    "except Exception as error:",
    "    fail(\"device_memory\", error)",
    "",
    "cuda_compiler_path = shutil.which(\"nvcc\")",
    "if cuda_compiler_path is None:",
    "    cuda_compiler = {\"kind\": \"not_installed\"}",
    "else:",
    "    try:",
    "        compiler_process = subprocess.run([cuda_compiler_path, \"--version\"], check=True, capture_output=True, text=True, timeout=10)",
    "        compiler_match = re.search(r\"release\\s+([^,\\s]+)\", compiler_process.stdout)",
    "        if compiler_match is None:",
    "            raise RuntimeError(\"nvcc did not report a CUDA compiler version.\")",
    "        cuda_compiler = {\"kind\": \"installed\", \"version\": compiler_match.group(1)}",
    "    except Exception as error:",
    "        fail(\"cuda_compiler\", error)",
    "",
    "try:",
    "    with torch.no_grad():",
    "        model = torch.nn.Linear(2, 2, bias=False, device=device_name, dtype=torch.float32)",
    "        model.weight.copy_(torch.tensor([[1.0, 2.0], [3.0, 4.0]], device=device_name, dtype=torch.float32))",
    "        input_tensor = torch.tensor([[5.0, 6.0]], device=device_name, dtype=torch.float32)",
    "        intermediate_tensor = model(input_tensor)",
    "        output_tensor = torch.relu(intermediate_tensor)",
    "        expected_tensor = torch.tensor([[17.0, 39.0]], device=device_name, dtype=torch.float32)",
    "        if not torch.equal(output_tensor, expected_tensor):",
    "            raise RuntimeError(\"The CUDA operation returned an incorrect value.\")",
    "        torch.cuda.synchronize(device_index)",
    "        output_sum = output_tensor.sum().item()",
    "except Exception as error:",
    "    fail(\"gpu_operation\", error)",
    "",
    "model_device = str(next(model.parameters()).device)",
    "input_device = str(input_tensor.device)",
    "intermediate_device = str(intermediate_tensor.device)",
    "output_device = str(output_tensor.device)",
    "if any(value != device_name for value in [model_device, input_device, intermediate_device, output_device]):",
    "    fail(\"output_placement\", RuntimeError(\"The model, input, intermediate value, and output did not stay on the requested CUDA device.\"))",
    "",
    "device_uuid = getattr(properties, \"uuid\", None)",
    "physical_device = {\"kind\": \"uuid\", \"uuid\": str(device_uuid)} if device_uuid else {\"kind\": \"unavailable\"}",
    "cudnn_version = torch.backends.cudnn.version()",
    "cudnn_runtime = {\"kind\": \"available\", \"version\": cudnn_version} if isinstance(cudnn_version, int) and cudnn_version > 0 else {\"kind\": \"not_available\"}",
    "report = {",
    "    \"kind\": \"ready\",",
    "    \"profile\": \"pytorch\",",
    "    \"backend\": \"cuda\",",
    "    \"device\": device_name,",
    "    \"deviceName\": properties.name,",
    "    \"physicalDevice\": physical_device,",
    "    \"pythonVersion\": sys.version.split()[0],",
    "    \"pytorchVersion\": torch.__version__,",
    "    \"nvidiaDriverVersion\": driver_version,",
    "    \"cudaRuntimeVersion\": cuda_runtime_version,",
    "    \"cudaCompiler\": cuda_compiler,",
    "    \"cudnnRuntime\": cudnn_runtime,",
    "    \"driverRuntimeCompatible\": True,",
    "    \"computeCapability\": {\"major\": properties.major, \"minor\": properties.minor},",
    "    \"totalMemoryBytes\": total_memory_bytes,",
    "    \"availableMemoryBytes\": available_memory_bytes,",
    "    \"dtype\": \"torch.float32\",",
    "    \"backendFlags\": {\"cudnnEnabled\": torch.backends.cudnn.enabled, \"matmulAllowTf32\": torch.backends.cuda.matmul.allow_tf32},",
    "    \"placement\": {\"model\": model_device, \"input\": input_device, \"intermediate\": intermediate_device, \"output\": output_device},",
    "    \"operation\": {\"kind\": \"linear_relu\", \"outputSum\": output_sum},",
    "}",
    "if minimum_available_memory_bytes is not None:",
    "    report[\"minimumAvailableMemoryBytes\"] = minimum_available_memory_bytes",
    "print(json.dumps(report, separators=(\",\", \":\")))",
  ].join("\n");
}
