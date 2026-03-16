"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import LanRoundedIcon from "@mui/icons-material/LanRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  DataGridPremium,
  GridColDef,
  GridPaginationModel,
  GridRowParams,
  GridSortModel,
} from "@mui/x-data-grid-premium";

import { ControlCenterSidebar } from "@/components/control-center-sidebar";
import {
  RemoteVpsInteractionLogRecord,
  RemoteVpsRecord,
  VpsLogListResponse,
  VpsListResponse,
  VpsMutationResponse,
  logInteractionTypeOptions,
  logResultOptions,
  vpsEnvironmentOptions,
  vpsProtocolOptions,
  vpsStatusOptions,
} from "@/lib/remote-vps-shared";
import { ScriptListResponse, ScriptRecord } from "@/lib/scripts-shared";

type ScreenState =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; vpsId: string }
  | { kind: "details"; vpsId: string }
  | { kind: "logs"; vpsId: string };

type FormErrors = Partial<Record<keyof VpsFormValues | "form", string>>;

interface VpsFormValues {
  name: string;
  host: string;
  port: string;
  protocol: RemoteVpsRecord["protocol"];
  environment: RemoteVpsRecord["environment"];
  region: string;
  provider: string;
  controllerSecretKey: string;
  tags: string;
  notes: string;
  isEnabled: boolean;
}

interface ControllerTaskStatusResponse {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  command?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  error?: unknown;
}

interface ControllerTaskResultResponse {
  taskId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  message?: string;
  result?: unknown;
  error?: unknown;
  taskLog?: unknown;
}

type TaskEngineMode = "deterministic" | "ai_driven";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCRIPT_POLL_INTERVAL_MS = 4000;
const SCRIPT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const SCRIPT_POLL_MAX_ATTEMPTS = Math.ceil(SCRIPT_POLL_TIMEOUT_MS / SCRIPT_POLL_INTERVAL_MS);

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getControllerTaskErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
      const details = error as {
        message: string;
        stepOrder?: unknown;
        stepKind?: unknown;
        instruction?: unknown;
      };
      const parts = [details.message];

      if (typeof details.stepOrder === "number" && Number.isFinite(details.stepOrder)) {
        parts.push(`step ${details.stepOrder}`);
      }

      if (typeof details.stepKind === "string" && details.stepKind) {
        parts.push(details.stepKind);
      }

      if (typeof details.instruction === "string" && details.instruction) {
        parts.push(`"${details.instruction}"`);
      }

      return parts.join(" | ");
    }

    if ("error" in error && typeof (error as { error?: unknown }).error === "string") {
      return (error as { error: string }).error;
    }
  }

  return "Remote controller reported a task failure.";
}

function getSkippedTaskOutputs(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.steps)) {
    return [] as Array<Record<string, unknown>>;
  }

  return payload.result.steps
    .map((step) => (isPlainObject(step) && isPlainObject(step.output) ? step.output : null))
    .filter((output): output is Record<string, unknown> => Boolean(output && output.skipped === true));
}

function getTaskEngineInfo(payload: unknown) {
  const engine = isPlainObject(payload) && isPlainObject(payload.result) && isPlainObject(payload.result.engine)
    ? payload.result.engine
    : null;

  const requestedMode = engine?.requestedMode === "ai_driven" ? "ai_driven" : engine?.requestedMode === "deterministic" ? "deterministic" : null;
  const resolver = typeof engine?.resolver === "string" ? engine.resolver : null;
  const aiSelections = typeof engine?.aiSelections === "number" ? engine.aiSelections : null;
  const aiFallbacks = typeof engine?.aiFallbacks === "number" ? engine.aiFallbacks : null;

  return {
    requestedMode,
    resolver,
    aiSelections,
    aiFallbacks,
  } as {
    requestedMode: TaskEngineMode | null;
    resolver: string | null;
    aiSelections: number | null;
    aiFallbacks: number | null;
  };
}

function getTaskEngineLabel(mode: TaskEngineMode | null) {
  if (mode === "ai_driven") {
    return "AI-driven";
  }

  if (mode === "deterministic") {
    return "Deterministic";
  }

  return "-";
}

function getInteractionEngineInfo(log: RemoteVpsInteractionLogRecord) {
  const taskEngine = getTaskEngineInfo(log.responsePayload);

  if (taskEngine.requestedMode) {
    return taskEngine;
  }

  if (isPlainObject(log.requestPayload)) {
    const requestMode = log.requestPayload.engineMode;

    if (requestMode === "ai_driven" || requestMode === "deterministic") {
      return {
        requestedMode: requestMode,
        resolver: null,
        aiSelections: null,
        aiFallbacks: null,
      } as {
        requestedMode: TaskEngineMode | null;
        resolver: string | null;
        aiSelections: number | null;
        aiFallbacks: number | null;
      };
    }
  }

  return taskEngine;
}

function getTaskStepResolutionIndicators(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result) || !Array.isArray(payload.result.steps)) {
    return [] as Array<{
      order: number;
      kind: string;
      instruction: string;
      resolver: string;
      usedAi: boolean;
      fallbackReason: string | null;
    }>;
  }

  return payload.result.steps
    .map((step) => {
      if (!isPlainObject(step) || !isPlainObject(step.resolution)) {
        return null;
      }

      return {
        order: typeof step.order === "number" ? step.order : 0,
        kind: typeof step.kind === "string" ? step.kind : "",
        instruction: typeof step.instruction === "string" ? step.instruction : "",
        resolver: typeof step.resolution.resolver === "string" ? step.resolution.resolver : "",
        usedAi: step.resolution.usedAi === true,
        fallbackReason:
          typeof step.resolution.fallbackReason === "string"
            ? step.resolution.fallbackReason
            : null,
      };
    })
    .filter(
      (
        step
      ): step is {
        order: number;
        kind: string;
        instruction: string;
        resolver: string;
        usedAi: boolean;
        fallbackReason: string | null;
      } => Boolean(step && step.resolver)
    );
}

function getTaskStepResolutionSummary(payload: unknown) {
  const indicators = getTaskStepResolutionIndicators(payload);

  if (indicators.length === 0) {
    return "";
  }

  const aiResolved = indicators.filter((step) => step.usedAi).length;
  const fallbackResolved = indicators.filter((step) => step.resolver === "deterministic_fallback").length;
  const deterministicResolved = indicators.filter((step) => step.resolver === "deterministic").length;
  const parts: string[] = [];

  if (aiResolved > 0) {
    parts.push(`${aiResolved} AI-resolved`);
  }

  if (fallbackResolved > 0) {
    parts.push(`${fallbackResolved} fallback`);
  }

  if (deterministicResolved > 0) {
    parts.push(`${deterministicResolved} deterministic`);
  }

  return parts.join(" | ");
}

function formatTaskStepResolutionIndicators(payload: unknown) {
  const indicators = getTaskStepResolutionIndicators(payload);

  return indicators.map((step) => ({
    order: step.order,
    kind: step.kind,
    resolver: step.resolver,
    usedAi: step.usedAi,
    fallbackReason: step.fallbackReason,
    instruction: step.instruction,
  }));
}

function resolutionChipColor(resolver: string) {
  switch (resolver) {
    case "ai_driven":
      return "warning" as const;
    case "deterministic_fallback":
      return "info" as const;
    case "deterministic":
      return "default" as const;
    default:
      return "default" as const;
  }
}

function resolutionChipLabel(resolver: string) {
  switch (resolver) {
    case "ai_driven":
      return "AI";
    case "deterministic_fallback":
      return "Fallback";
    case "deterministic":
      return "Deterministic";
    default:
      return resolver || "Unknown";
  }
}

function getTaskResultSummary(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.result)) {
    return "";
  }

  const skippedOutputs = getSkippedTaskOutputs(payload);
  const alreadyActiveSkips = skippedOutputs.filter((output) => output.reason === "already_pressed").length;
  const endedEarly = payload.result.endedEarly === true;
  const engine = getTaskEngineInfo(payload);
  const stepResolutionSummary = getTaskStepResolutionSummary(payload);
  const parts: string[] = [];

  if (engine.requestedMode) {
    let engineSummary = `Engine: ${getTaskEngineLabel(engine.requestedMode)}`;

    if (engine.requestedMode === "ai_driven") {
      if (engine.resolver === "ai_driven") {
        const selectionCount = engine.aiSelections ?? 0;
        engineSummary += selectionCount > 0
          ? ` with ${selectionCount} AI-selected target${selectionCount === 1 ? "" : "s"}`
          : " with AI resolution enabled";
      } else if (engine.resolver === "deterministic_fallback") {
        engineSummary += ". Resolver fell back to deterministic matching";
      }
    }

    parts.push(engineSummary);
  }

  if (alreadyActiveSkips > 0) {
    parts.push(
      alreadyActiveSkips === 1
        ? "1 toggle step was skipped because the target was already active."
        : `${alreadyActiveSkips} toggle steps were skipped because the target was already active.`
    );
  }

  if (endedEarly) {
    parts.push("The script completed and ended early through branch logic.");
  }

  if (stepResolutionSummary) {
    parts.push(`Step resolution: ${stepResolutionSummary}.`);
  }

  return parts.join(" ");
}

function getTaskCompletionSnackbarMessage(
  payload: ControllerTaskResultResponse,
  scriptName: string,
  vpsName: string
) {
  const summary = getTaskResultSummary(payload);

  return summary
    ? `Script "${scriptName}" completed on ${vpsName}. ${summary}`
    : `Script "${scriptName}" completed on ${vpsName}.`;
}

function getTaskLogText(payload: unknown) {
  if (!isPlainObject(payload) || !isPlainObject(payload.taskLog) || !isPlainObject(payload.taskLog.chunks)) {
    return "";
  }

  return Object.entries(payload.taskLog.chunks)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([, chunk]) => (typeof chunk === "string" ? chunk : ""))
    .join("");
}

const operatorId = "operator@control-center";

function formatDateTime(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDuration(value: number | null) {
  if (value === null) {
    return "-";
  }

  return `${value} ms`;
}

function toFormValues(record?: RemoteVpsRecord | null): VpsFormValues {
  return {
    name: record?.name ?? "",
    host: record?.host ?? "",
    port: record ? String(record.port) : "80",
    protocol: record?.protocol ?? "https",
    environment: record?.environment ?? "production",
    region: record?.region ?? "",
    provider: record?.provider ?? "",
    controllerSecretKey: "",
    tags: record?.tags.join(", ") ?? "",
    notes: record?.notes ?? "",
    isEnabled: record?.isEnabled ?? true,
  };
}

function statusColor(status: RemoteVpsRecord["status"]) {
  switch (status) {
    case "online":
      return "success";
    case "degraded":
      return "warning";
    case "offline":
      return "error";
    case "disabled":
      return "default";
    default:
      return "info";
  }
}

function resultColor(result: RemoteVpsInteractionLogRecord["result"]) {
  switch (result) {
    case "success":
      return "success";
    case "pending":
    case "retrying":
      return "info";
    case "timeout":
      return "warning";
    case "failed":
    case "rejected":
      return "error";
    default:
      return "default";
  }
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-operator-id": operatorId,
      ...(init?.headers ?? {}),
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw payload;
  }

  return payload as T;
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1.25}
      sx={{ height: "100%", px: 2, textAlign: "center" }}
    >
      <Box
        sx={{
          width: 52,
          height: 52,
          borderRadius: "8px",
          background:
            "radial-gradient(circle at top, rgba(14, 98, 81, 0.18), rgba(14, 98, 81, 0.04))",
          display: "grid",
          placeItems: "center",
        }}
      >
        <LanRoundedIcon color="primary" />
      </Box>
      <Typography variant="h6">{title}</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 360 }}>
        {body}
      </Typography>
      {action}
    </Stack>
  );
}

function RemoteVpsFormScreen({
  mode,
  record,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  record?: RemoteVpsRecord | null;
  onCancel: () => void;
  onSaved: (item: RemoteVpsRecord, message: string) => void;
}) {
  const [values, setValues] = useState<VpsFormValues>(toFormValues(record));
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, startSubmitting] = useTransition();
  const [dirty, setDirty] = useState(false);
  const [clearStoredSecret, setClearStoredSecret] = useState(false);

  useEffect(() => {
    if (!dirty) {
      return undefined;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const handleChange = <K extends keyof VpsFormValues>(key: K, value: VpsFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "controllerSecretKey") {
      setClearStoredSecret(false);
    }
    setDirty(true);
  };

  const runClientValidation = () => {
    const nextErrors: FormErrors = {};

    if (!values.name.trim()) {
      nextErrors.name = "Name is required.";
    }

    if (!values.host.trim()) {
      nextErrors.host = "Host is required.";
    }

    const port = Number(values.port);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      nextErrors.port = "Port must be between 1 and 65535.";
    }

    if (!values.provider.trim()) {
      nextErrors.provider = "Provider is required.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleCancel = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }

    onCancel();
  };

  const handleSubmit = () => {
    if (!runClientValidation()) {
      return;
    }

    startSubmitting(async () => {
      try {
        const payload: Record<string, unknown> = {
          ...values,
          port: Number(values.port),
          tags: values.tags,
        };

        if (mode === "edit" && record?.hasControllerSecret && clearStoredSecret) {
          payload.controllerSecretKey = "";
        } else if (
          mode === "edit" &&
          record?.hasControllerSecret &&
          !values.controllerSecretKey.trim()
        ) {
          delete payload.controllerSecretKey;
        }

        const endpoint = mode === "create" ? "/api/vps" : `/api/vps/${record?.id}`;
        const method = mode === "create" ? "POST" : "PATCH";
        const response = await requestJson<VpsMutationResponse>(endpoint, {
          method,
          body: JSON.stringify(payload),
        });

        setDirty(false);
        onSaved(response.item, response.message);
      } catch (error) {
        if (typeof error === "object" && error && "errors" in error) {
          setErrors((error as { errors: FormErrors }).errors);
          return;
        }

        setErrors({ form: `Unable to ${mode === "create" ? "create" : "save"} VPS.` });
      }
    });
  };

  return (
    <Card sx={{ height: "100%", overflow: "auto" }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h5">
              {mode === "create" ? "Register VPS" : `Edit ${record?.name ?? "VPS"}`}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              Capture connection details, grouping tags, and operational notes.
            </Typography>
          </Box>

          {errors.form ? <Alert severity="error">{errors.form}</Alert> : null}

          <Box
            sx={{
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            }}
          >
            <TextField
              label="Name"
              value={values.name}
              onChange={(event) => handleChange("name", event.target.value)}
              error={Boolean(errors.name)}
              helperText={errors.name}
              required
            />
            <TextField
              label="Host"
              value={values.host}
              onChange={(event) => handleChange("host", event.target.value)}
              error={Boolean(errors.host)}
              helperText={errors.host}
              required
            />
            <TextField
              label="Port"
              value={values.port}
              onChange={(event) => handleChange("port", event.target.value)}
              error={Boolean(errors.port)}
              helperText={errors.port}
              required
            />
            <FormControl>
              <InputLabel id="protocol-label">Protocol</InputLabel>
              <Select
                labelId="protocol-label"
                value={values.protocol}
                label="Protocol"
                onChange={(event) =>
                  handleChange("protocol", event.target.value as VpsFormValues["protocol"])
                }
              >
                {vpsProtocolOptions.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option.toUpperCase()}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl>
              <InputLabel id="environment-label">Environment</InputLabel>
              <Select
                labelId="environment-label"
                value={values.environment}
                label="Environment"
                onChange={(event) =>
                  handleChange(
                    "environment",
                    event.target.value as VpsFormValues["environment"]
                  )
                }
              >
                {vpsEnvironmentOptions.map((option) => (
                  <MenuItem key={option} value={option}>
                    {option}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Provider"
              value={values.provider}
              onChange={(event) => handleChange("provider", event.target.value)}
              error={Boolean(errors.provider)}
              helperText={errors.provider}
              required
            />
            <TextField
              label="Controller secret"
              type="password"
              value={values.controllerSecretKey}
              onChange={(event) => handleChange("controllerSecretKey", event.target.value)}
              error={Boolean(errors.controllerSecretKey)}
              helperText={
                errors.controllerSecretKey ??
                (mode === "edit" && record?.hasControllerSecret
                  ? clearStoredSecret
                    ? "The stored controller secret will be removed when you save."
                    : `Stored on the server as ${record.controllerSecretKeyMasked}. Leave blank to keep it, or use the clear option below.`
                  : "Shared secret used when the control center calls this VPS controller.")
              }
              disabled={clearStoredSecret}
              sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }}
            />
            {mode === "edit" && record?.hasControllerSecret ? (
              <FormControl sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={clearStoredSecret}
                      onChange={(event) => {
                        setClearStoredSecret(event.target.checked);
                        setDirty(true);
                      }}
                    />
                  }
                  label="Clear stored controller secret"
                />
                <FormHelperText>
                  Use this when you want to remove the existing secret from this VPS record.
                </FormHelperText>
              </FormControl>
            ) : null}
            <TextField
              label="Region"
              value={values.region}
              onChange={(event) => handleChange("region", event.target.value)}
            />
            <TextField
              label="Tags"
              value={values.tags}
              onChange={(event) => handleChange("tags", event.target.value)}
              helperText="Comma-separated labels for grouping and filtering."
              sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }}
            />
            <TextField
              label="Notes"
              value={values.notes}
              onChange={(event) => handleChange("notes", event.target.value)}
              multiline
              minRows={4}
              sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }}
            />
          </Box>

          <FormControl error={Boolean(errors.form)}>
            <FormControlLabel
              control={
                <Switch
                  checked={values.isEnabled}
                  onChange={(event) => handleChange("isEnabled", event.target.checked)}
                />
              }
              label="Enabled in the control plane"
            />
            <FormHelperText>
              Disabled records remain in the registry but are excluded from active operations.
            </FormHelperText>
          </FormControl>

          <Stack direction="row" spacing={2}>
            <Button variant="contained" onClick={handleSubmit} disabled={isSubmitting}>
              {mode === "create" ? "Create" : "Save"}
            </Button>
            <Button variant="outlined" onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

function RemoteVpsFormLoadingScreen() {
  return (
    <Card sx={{ height: "100%", overflow: "auto" }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack spacing={2}>
          <Box>
            <Skeleton variant="text" width={180} height={40} />
            <Skeleton variant="text" width={320} height={24} sx={{ mt: 0.5 }} />
          </Box>

          <Box
            sx={{
              display: "grid",
              gap: 1.5,
              gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            }}
          >
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }} />
            <Skeleton variant="rounded" height={120} sx={{ gridColumn: { xs: "auto", md: "1 / span 2" } }} />
          </Box>

          <Skeleton variant="rounded" width={220} height={40} />

          <Stack direction="row" spacing={2}>
            <Skeleton variant="rounded" width={96} height={36} />
            <Skeleton variant="rounded" width={96} height={36} />
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function RemoteVpsControlCenter() {
  const [screen, setScreen] = useState<ScreenState>({ kind: "list" });
  const [listData, setListData] = useState<VpsListResponse>({
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 10,
  });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState("");
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({
    page: 0,
    pageSize: 10,
  });
  const [sortModel, setSortModel] = useState<GridSortModel>([
    { field: "updatedAt", sort: "desc" },
  ]);
  const [selectedVps, setSelectedVps] = useState<RemoteVpsRecord | null>(null);
  const [detailLogs, setDetailLogs] = useState<RemoteVpsInteractionLogRecord[]>([]);
  const [logsData, setLogsData] = useState<VpsLogListResponse>({
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
  });
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsPaginationModel, setLogsPaginationModel] = useState<GridPaginationModel>({
    page: 0,
    pageSize: 20,
  });
  const [logResultFilter, setLogResultFilter] = useState("");
  const [logTypeFilter, setLogTypeFilter] = useState("");
  const [logStartAt, setLogStartAt] = useState("");
  const [logEndAt, setLogEndAt] = useState("");
  const [selectedLog, setSelectedLog] =
    useState<RemoteVpsInteractionLogRecord | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteVpsRecord | null>(null);
  const [clearLogsTarget, setClearLogsTarget] = useState<RemoteVpsRecord | null>(null);
  const [actionVpsId, setActionVpsId] = useState<string | null>(null);
  const [executeDialogVps, setExecuteDialogVps] = useState<RemoteVpsRecord | null>(null);
  const [availableScripts, setAvailableScripts] = useState<ScriptRecord[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [scriptsError, setScriptsError] = useState<string | null>(null);
  const [executeDialogError, setExecuteDialogError] = useState<string | null>(null);
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [isExecutingScript, setIsExecutingScript] = useState(false);
  const [isNavigating, startNavigation] = useTransition();
  const [refreshToken, setRefreshToken] = useState(0);
  const hasMountedRef = useRef(false);
  const activeScriptPollIdsRef = useRef(new Set<number>());
  const scriptPollAbortControllersRef = useRef(new Set<AbortController>());
  const nextScriptPollIdRef = useRef(0);
  const listPaginationTimeoutRef = useRef<number | null>(null);
  const listSortTimeoutRef = useRef<number | null>(null);
  const logsPaginationTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    hasMountedRef.current = true;
    const activeScriptPollIds = activeScriptPollIdsRef.current;
    const scriptPollAbortControllers = scriptPollAbortControllersRef.current;

    return () => {
      hasMountedRef.current = false;
      activeScriptPollIds.clear();

      scriptPollAbortControllers.forEach((controller) => {
        controller.abort();
      });
      scriptPollAbortControllers.clear();

      if (listPaginationTimeoutRef.current !== null) {
        window.clearTimeout(listPaginationTimeoutRef.current);
      }

      if (listSortTimeoutRef.current !== null) {
        window.clearTimeout(listSortTimeoutRef.current);
      }

      if (logsPaginationTimeoutRef.current !== null) {
        window.clearTimeout(logsPaginationTimeoutRef.current);
      }
    };
  }, []);

  function isScriptPollActive(pollId: number) {
    return hasMountedRef.current && activeScriptPollIdsRef.current.has(pollId);
  }

  async function requestJsonForScriptPoll<T>(input: string) {
    const controller = new AbortController();
    scriptPollAbortControllersRef.current.add(controller);

    try {
      return await requestJson<T>(input, { signal: controller.signal });
    } finally {
      scriptPollAbortControllersRef.current.delete(controller);
    }
  }

  function updateListPaginationModel(nextModel: GridPaginationModel) {
    if (!hasMountedRef.current) {
      return;
    }

    if (listPaginationTimeoutRef.current !== null) {
      window.clearTimeout(listPaginationTimeoutRef.current);
    }

    listPaginationTimeoutRef.current = window.setTimeout(() => {
      if (!hasMountedRef.current) {
        return;
      }

      setPaginationModel((current) => {
        if (
          current.page === nextModel.page &&
          current.pageSize === nextModel.pageSize
        ) {
          return current;
        }

        return nextModel;
      });
    }, 0);
  }

  function updateListSortModel(nextModel: GridSortModel) {
    if (!hasMountedRef.current) {
      return;
    }

    if (listSortTimeoutRef.current !== null) {
      window.clearTimeout(listSortTimeoutRef.current);
    }

    listSortTimeoutRef.current = window.setTimeout(() => {
      if (!hasMountedRef.current) {
        return;
      }

      setSortModel((current) => {
        const currentEntry = current[0];
        const nextEntry = nextModel[0];

        if (
          current.length === nextModel.length &&
          currentEntry?.field === nextEntry?.field &&
          currentEntry?.sort === nextEntry?.sort
        ) {
          return current;
        }

        return nextModel;
      });
    }, 0);
  }

  function updateLogsPaginationModel(nextModel: GridPaginationModel) {
    if (!hasMountedRef.current) {
      return;
    }

    if (logsPaginationTimeoutRef.current !== null) {
      window.clearTimeout(logsPaginationTimeoutRef.current);
    }

    logsPaginationTimeoutRef.current = window.setTimeout(() => {
      if (!hasMountedRef.current) {
        return;
      }

      setLogsPaginationModel((current) => {
        if (
          current.page === nextModel.page &&
          current.pageSize === nextModel.pageSize
        ) {
          return current;
        }

        return nextModel;
      });
    }, 0);
  }

  const activeVpsId =
    screen.kind === "edit" || screen.kind === "details" || screen.kind === "logs"
      ? screen.vpsId
      : null;

  const selectedScript = useMemo(
    () => availableScripts.find((item) => item.id === selectedScriptId) ?? null,
    [availableScripts, selectedScriptId]
  );

  useEffect(() => {
    let ignore = false;

    async function loadList() {
      setListLoading(true);
      setListError(null);

      try {
        const sortEntry = sortModel[0];
        const params = new URLSearchParams({
          page: String(paginationModel.page + 1),
          pageSize: String(paginationModel.pageSize),
          search: deferredSearch,
          status: statusFilter,
          environment: environmentFilter,
          sortField: sortEntry?.field ?? "updatedAt",
          sortDirection: sortEntry?.sort ?? "desc",
        });
        const response = await requestJson<VpsListResponse>(`/api/vps?${params.toString()}`);

        if (!ignore) {
          setListData(response);
        }
      } catch {
        if (!ignore) {
          setListError("Unable to load the VPS registry.");
        }
      } finally {
        if (!ignore) {
          setListLoading(false);
        }
      }
    }

    void loadList();

    return () => {
      ignore = true;
    };
  }, [
    deferredSearch,
    environmentFilter,
    paginationModel.page,
    paginationModel.pageSize,
    refreshToken,
    sortModel,
    statusFilter,
  ]);

  useEffect(() => {
    if (!activeVpsId) {
      setSelectedVps(null);
      return;
    }

    let ignore = false;

    async function loadSelectedVps() {
      try {
        const response = await requestJson<{ item: RemoteVpsRecord }>(`/api/vps/${activeVpsId}`);

        if (!ignore) {
          setSelectedVps(response.item);
        }
      } catch {
        if (!ignore) {
          setSelectedVps(null);
        }
      }
    }

    void loadSelectedVps();

    return () => {
      ignore = true;
    };
  }, [activeVpsId, refreshToken]);

  useEffect(() => {
    if (!executeDialogVps) {
      setAvailableScripts([]);
      setScriptsLoading(false);
      setScriptsError(null);
      setExecuteDialogError(null);
      setSelectedScriptId("");
      return;
    }

    let ignore = false;

    async function loadScripts() {
      setScriptsLoading(true);
      setScriptsError(null);
      setExecuteDialogError(null);

      try {
        const response = await requestJson<ScriptListResponse>(
          "/api/scripts?page=1&pageSize=100&disabled=false&sortField=updatedAt&sortDirection=desc"
        );

        if (!ignore) {
          setAvailableScripts(response.items);
          setSelectedScriptId((current) => {
            if (current && response.items.some((item) => item.id === current)) {
              return current;
            }

            return response.items[0]?.id ?? "";
          });
        }
      } catch {
        if (!ignore) {
          setAvailableScripts([]);
          setSelectedScriptId("");
          setScriptsError("Unable to load available scripts.");
        }
      } finally {
        if (!ignore) {
          setScriptsLoading(false);
        }
      }
    }

    void loadScripts();

    return () => {
      ignore = true;
    };
  }, [executeDialogVps]);

  useEffect(() => {
    if (screen.kind !== "details") {
      setDetailLogs([]);
      return;
    }

    const vpsId = screen.vpsId;
    let ignore = false;

    async function loadDetailLogs() {
      try {
        const response = await requestJson<VpsLogListResponse>(
          `/api/vps/${vpsId}/logs?page=1&pageSize=6`
        );

        if (!ignore) {
          setDetailLogs(response.items);
        }
      } catch {
        if (!ignore) {
          setDetailLogs([]);
        }
      }
    }

    void loadDetailLogs();

    return () => {
      ignore = true;
    };
  }, [refreshToken, screen]);

  useEffect(() => {
    if (screen.kind !== "logs") {
      return;
    }

    const vpsId = screen.vpsId;
    let ignore = false;

    async function loadLogs() {
      setLogsLoading(true);
      setLogsError(null);

      try {
        const params = new URLSearchParams({
          page: String(logsPaginationModel.page + 1),
          pageSize: String(logsPaginationModel.pageSize),
          result: logResultFilter,
          interactionType: logTypeFilter,
          startAt: logStartAt,
          endAt: logEndAt,
        });
        const response = await requestJson<VpsLogListResponse>(
          `/api/vps/${vpsId}/logs?${params.toString()}`
        );

        if (!ignore) {
          setLogsData(response);
        }
      } catch {
        if (!ignore) {
          setLogsError("Unable to load interaction history.");
        }
      } finally {
        if (!ignore) {
          setLogsLoading(false);
        }
      }
    }

    void loadLogs();

    return () => {
      ignore = true;
    };
  }, [
    logEndAt,
    logResultFilter,
    logStartAt,
    logTypeFilter,
    logsPaginationModel.page,
    logsPaginationModel.pageSize,
    refreshToken,
    screen,
  ]);

  const listColumns = useMemo<GridColDef<RemoteVpsRecord>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1.2,
        minWidth: 180,
      },
      {
        field: "host",
        headerName: "Host",
        flex: 1.1,
        minWidth: 180,
      },
      {
        field: "port",
        headerName: "Port",
        width: 90,
      },
      {
        field: "environment",
        headerName: "Environment",
        minWidth: 120,
      },
      {
        field: "provider",
        headerName: "Provider",
        minWidth: 140,
      },
      {
        field: "status",
        headerName: "Status",
        minWidth: 220,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
            <Chip label={row.status} color={statusColor(row.status)} size="small" />
            {row.timestampWarnings.length > 0 ? (
              <Tooltip title={`Fallback timestamps: ${row.timestampWarnings.join(", ")}`}>
                <Chip size="small" label="legacy timestamps" color="warning" variant="outlined" />
              </Tooltip>
            ) : null}
          </Stack>
        ),
      },
      {
        field: "lastSeenAt",
        headerName: "Last seen",
        minWidth: 180,
        valueFormatter: (value) => formatDateTime(value as string | null),
      },
      {
        field: "controllerVersion",
        headerName: "Controller version",
        minWidth: 150,
        valueGetter: (_value, row) => row.controllerVersion || "-",
      },
      {
        field: "actions",
        headerName: "Actions",
        sortable: false,
        filterable: false,
        minWidth: 220,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={0.5}>
            <Tooltip title="View details">
              <IconButton
                size="small"
                onClick={() => startNavigation(() => setScreen({ kind: "details", vpsId: row.id }))}
              >
                <VisibilityRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Edit">
              <IconButton
                size="small"
                onClick={() => startNavigation(() => setScreen({ kind: "edit", vpsId: row.id }))}
              >
                <EditRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Execute script">
              <span>
                <IconButton
                  size="small"
                  disabled={actionVpsId === row.id || !row.isEnabled}
                  onClick={() => openExecuteScriptDialog(row)}
                >
                  <PlayArrowRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Logs">
              <IconButton
                size="small"
                onClick={() => startNavigation(() => setScreen({ kind: "logs", vpsId: row.id }))}
              >
                <HistoryRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Test connection">
              <span>
                <IconButton
                  size="small"
                  disabled={actionVpsId === row.id}
                  onClick={() => void triggerProbe(row.id, "test-connection")}
                >
                  <LanRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton size="small" color="error" onClick={() => setDeleteTarget(row)}>
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ),
      },
    ],
    [actionVpsId, startNavigation]
  );

  const logColumns = useMemo<GridColDef<RemoteVpsInteractionLogRecord>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Timestamp",
        minWidth: 180,
        valueFormatter: (value) => formatDateTime(value as string | null),
      },
      {
        field: "interactionType",
        headerName: "Type",
        minWidth: 150,
      },
      {
        field: "direction",
        headerName: "Direction",
        minWidth: 160,
      },
      {
        field: "result",
        headerName: "Result",
        minWidth: 120,
        renderCell: ({ row }) => (
          <Chip label={row.result} color={resultColor(row.result)} size="small" />
        ),
      },
      {
        field: "engineMode",
        headerName: "Engine",
        minWidth: 140,
        sortable: false,
        valueGetter: (_value, row) => getInteractionEngineInfo(row).requestedMode ?? "",
        renderCell: ({ row }) => {
          const engine = getInteractionEngineInfo(row);

          return engine.requestedMode ? (
            <Chip
              label={getTaskEngineLabel(engine.requestedMode)}
              size="small"
              color={engine.requestedMode === "ai_driven" ? "warning" : "default"}
              variant={engine.requestedMode === "ai_driven" ? "filled" : "outlined"}
            />
          ) : (
            <Typography color="text.secondary">-</Typography>
          );
        },
      },
      {
        field: "requestPath",
        headerName: "Path",
        minWidth: 180,
        flex: 1,
      },
      {
        field: "responseStatusCode",
        headerName: "HTTP",
        width: 90,
        valueGetter: (_value, row) => row.responseStatusCode ?? "-",
      },
      {
        field: "durationMs",
        headerName: "Duration",
        minWidth: 120,
        valueFormatter: (value) => formatDuration(value as number | null),
      },
      {
        field: "correlationId",
        headerName: "Correlation ID",
        minWidth: 260,
      },
    ],
    []
  );

  function openExecuteScriptDialog(vps: RemoteVpsRecord) {
    setExecuteDialogVps(vps);
  }

  async function pollScriptExecution(options: {
    vpsId: string;
    taskId: string;
    scriptName: string;
    vpsName: string;
  }) {
    const pollId = nextScriptPollIdRef.current + 1;
    nextScriptPollIdRef.current = pollId;
    activeScriptPollIdsRef.current.add(pollId);
    const startedAt = Date.now();
    let attempts = 0;

    try {
      while (isScriptPollActive(pollId)) {
        if (attempts >= SCRIPT_POLL_MAX_ATTEMPTS || Date.now() - startedAt >= SCRIPT_POLL_TIMEOUT_MS) {
          if (isScriptPollActive(pollId)) {
            setSnackbar(
              `Stopped tracking script "${options.scriptName}" on ${options.vpsName} after ${Math.round(
                SCRIPT_POLL_TIMEOUT_MS / 60000
              )} minutes. Check interaction logs for the latest status.`
            );
            setRefreshToken((value) => value + 1);
          }

          return;
        }

        attempts += 1;
        await sleep(SCRIPT_POLL_INTERVAL_MS);

        if (!isScriptPollActive(pollId)) {
          return;
        }

        const statusResponse = await requestJsonForScriptPoll<ControllerTaskStatusResponse>(
          `/api/vps/${options.vpsId}/commands/${options.taskId}/status`
        );

        if (!isScriptPollActive(pollId)) {
          return;
        }

        if (statusResponse.status === "pending" || statusResponse.status === "in_progress") {
          continue;
        }

        if (statusResponse.status === "failed") {
          if (isScriptPollActive(pollId)) {
            setSnackbar(
              `Script "${options.scriptName}" failed on ${options.vpsName}: ${getControllerTaskErrorMessage(statusResponse.error)}`
            );
            setRefreshToken((value) => value + 1);
          }

          return;
        }

        const resultResponse = await requestJsonForScriptPoll<ControllerTaskResultResponse>(
          `/api/vps/${options.vpsId}/commands/${options.taskId}/results`
        );

        if (!isScriptPollActive(pollId)) {
          return;
        }

        if (resultResponse.status === "completed") {
          setSnackbar(getTaskCompletionSnackbarMessage(resultResponse, options.scriptName, options.vpsName));
        } else {
          const message = getControllerTaskErrorMessage(resultResponse.error);
          setSnackbar(`Script \"${options.scriptName}\" failed on ${options.vpsName}: ${message}`);
        }

        setRefreshToken((value) => value + 1);
        return;
      }
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }

      if (isScriptPollActive(pollId)) {
        setSnackbar(`Unable to finish tracking script \"${options.scriptName}\" on ${options.vpsName}. Check interaction logs.`);
        setRefreshToken((value) => value + 1);
      }
    } finally {
      activeScriptPollIdsRef.current.delete(pollId);

      if (hasMountedRef.current) {
        setActionVpsId((current) => (current === options.vpsId ? null : current));
      }
    }
  }

  async function executeSelectedScript() {
    if (!executeDialogVps) {
      return;
    }

    if (!selectedScript) {
      setExecuteDialogError("Select a script to execute.");
      return;
    }

    setIsExecutingScript(true);
    setExecuteDialogError(null);

    try {
      const response = await requestJson<ControllerTaskStatusResponse>(
        `/api/vps/${executeDialogVps.id}/commands`,
        {
          method: "POST",
          body: JSON.stringify({
            command: "executeScript",
            scriptId: selectedScript.id,
            scriptName: selectedScript.name,
            engineMode: selectedScript.engineMode,
            script: selectedScript.structuredInstructions,
          }),
        }
      );

      if (!response.taskId) {
        throw new Error("Remote controller did not return a task ID.");
      }

      setActionVpsId(executeDialogVps.id);
      setExecuteDialogVps(null);
      setSnackbar(`Started script \"${selectedScript.name}\" on ${executeDialogVps.name}.`);
      setRefreshToken((value) => value + 1);

      void pollScriptExecution({
        vpsId: executeDialogVps.id,
        taskId: response.taskId,
        scriptName: selectedScript.name,
        vpsName: executeDialogVps.name,
      });
    } catch {
      setExecuteDialogError("Unable to execute the selected script.");
    } finally {
      setIsExecutingScript(false);
    }
  }

  async function triggerProbe(vpsId: string, action: "test-connection" | "health-check") {
    setActionVpsId(vpsId);

    try {
      await requestJson<{ item: RemoteVpsRecord }>(`/api/vps/${vpsId}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSnackbar(action === "test-connection" ? "Connection test completed." : "Health check completed.");
      setRefreshToken((value) => value + 1);
    } catch {
      setSnackbar(action === "test-connection" ? "Connection test failed." : "Health check failed.");
    } finally {
      setActionVpsId(null);
    }
  }

  async function refreshSelectedLog(log: RemoteVpsInteractionLogRecord) {
    if (screen.kind !== "logs") {
      return;
    }

    try {
      const response = await requestJson<{ item: RemoteVpsInteractionLogRecord }>(
        `/api/vps/${screen.vpsId}/logs/${log.id}`
      );
      setSelectedLog(response.item);
    } catch {
      setSelectedLog(log);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) {
      return;
    }

    try {
      await requestJson<{ message: string }>(`/api/vps/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      setSnackbar(`Deleted ${deleteTarget.name}.`);
      setDeleteTarget(null);
      setRefreshToken((value) => value + 1);
      setScreen({ kind: "list" });
    } catch {
      setSnackbar("Delete failed.");
    }
  }

  async function confirmClearLogs() {
    if (!clearLogsTarget) {
      return;
    }

    try {
      await requestJson<{ deletedCount: number; message: string }>(
        `/api/vps/${clearLogsTarget.id}/logs`,
        {
          method: "DELETE",
          body: JSON.stringify({}),
        }
      );

      setSelectedLog(null);
      setLogsData((current) => ({ ...current, items: [], totalCount: 0 }));
      setDetailLogs([]);
      setClearLogsTarget(null);
      setLogsPaginationModel((current) => ({ ...current, page: 0 }));
      setRefreshToken((value) => value + 1);
      setSnackbar(`Cleared interaction logs for ${clearLogsTarget.name}.`);
    } catch {
      setSnackbar("Unable to clear interaction logs.");
    }
  }

  const currentTitle =
    screen.kind === "create"
      ? "Create VPS"
      : screen.kind === "edit"
        ? "Edit VPS"
        : screen.kind === "details"
          ? "VPS Details"
          : screen.kind === "logs"
            ? "Interaction Logs"
            : "Remote VPS";

  const currentSubtitle =
    screen.kind === "create"
      ? "Add a controller endpoint."
      : screen.kind === "edit"
        ? "Update endpoint settings."
        : screen.kind === "details"
          ? "Inspect status, metadata, and recent events."
          : screen.kind === "logs"
            ? "Review request and health history."
            : "Manage controller endpoints and health.";

  return (
    <Box sx={{ height: "100vh", overflow: "hidden", display: "flex", backgroundColor: "background.default" }}>
      <ControlCenterSidebar
        title="Remote Fleet"
        description="Registry for endpoints, diagnostics, and notes."
        sections={[
          { href: "/", label: "Remote VPS", description: "Registry and diagnostics" },
          { href: "/scripts", label: "Scripts", description: "Authoring and conversion" },
        ]}
        activeHref="/"
        footerTitle="Registry posture"
        footerBody={`${listData.totalCount} active records with retained logs.`}
      />

      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <Box
          sx={{
            px: { xs: 1.25, md: 2.5 },
            py: 1.75,
            display: "flex",
            justifyContent: "space-between",
            alignItems: { xs: "flex-start", md: "center" },
            gap: 1.25,
            flexWrap: "wrap",
          }}
        >
          <Box>
            <Typography variant="h4">{currentTitle}</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: 560 }}>
              {currentSubtitle}
            </Typography>
          </Box>

          <Stack direction="row" spacing={0.75} alignItems="center">
            {screen.kind !== "list" ? (
              <Button
                variant="outlined"
                startIcon={<ArrowBackRoundedIcon />}
                onClick={() => startNavigation(() => setScreen({ kind: "list" }))}
              >
                Back
              </Button>
            ) : null}
            <Button
              variant="outlined"
              startIcon={<RefreshRoundedIcon />}
              onClick={() => setRefreshToken((value) => value + 1)}
            >
              Refresh
            </Button>
            {screen.kind === "list" ? (
              <Button
                variant="contained"
                startIcon={<AddRoundedIcon />}
                onClick={() => startNavigation(() => setScreen({ kind: "create" }))}
              >
                Add VPS
              </Button>
            ) : null}
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden", px: { xs: 1.25, md: 2.5 }, pb: 2.5 }}>
          {screen.kind === "create" ? (
            <RemoteVpsFormScreen
              key="create-vps"
              mode="create"
              onCancel={() => setScreen({ kind: "list" })}
              onSaved={(item, message) => {
                setSnackbar(message);
                setRefreshToken((value) => value + 1);
                setScreen({ kind: "details", vpsId: item.id });
              }}
            />
          ) : null}

          {screen.kind === "edit" ? (
            selectedVps ? (
              <RemoteVpsFormScreen
                key={`edit-${selectedVps.id}`}
                mode="edit"
                record={selectedVps}
                onCancel={() => setScreen({ kind: "details", vpsId: screen.vpsId })}
                onSaved={(item, message) => {
                  setSnackbar(message);
                  setRefreshToken((value) => value + 1);
                  setScreen({ kind: "details", vpsId: item.id });
                }}
              />
            ) : (
              <RemoteVpsFormLoadingScreen />
            )
          ) : null}

          {screen.kind === "list" ? (
            <Stack spacing={1.25} sx={{ height: "100%" }}>
              <Card>
                <CardContent>
                  <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5}>
                    <TextField
                      placeholder="Search by name, host, provider, or tags"
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setPaginationModel((current) => ({ ...current, page: 0 }));
                      }}
                      fullWidth
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchRoundedIcon />
                          </InputAdornment>
                        ),
                      }}
                    />
                    <FormControl sx={{ minWidth: 180 }}>
                      <InputLabel id="status-filter-label">Status</InputLabel>
                      <Select
                        labelId="status-filter-label"
                        value={statusFilter}
                        label="Status"
                        onChange={(event) => {
                          setStatusFilter(String(event.target.value));
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                        }}
                      >
                        <MenuItem value="">All statuses</MenuItem>
                        {vpsStatusOptions.map((option) => (
                          <MenuItem key={option} value={option}>
                            {option}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl sx={{ minWidth: 180 }}>
                      <InputLabel id="environment-filter-label">Environment</InputLabel>
                      <Select
                        labelId="environment-filter-label"
                        value={environmentFilter}
                        label="Environment"
                        onChange={(event) => {
                          setEnvironmentFilter(String(event.target.value));
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                        }}
                      >
                        <MenuItem value="">All environments</MenuItem>
                        {vpsEnvironmentOptions.map((option) => (
                          <MenuItem key={option} value={option}>
                            {option}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Stack>
                </CardContent>
              </Card>

              <Card sx={{ flex: 1, minHeight: 0 }}>
                <CardContent sx={{ height: "100%", p: 1.25 }}>
                  {listError ? <Alert severity="error">{listError}</Alert> : null}
                  <Box sx={{ height: "100%" }}>
                    <DataGridPremium
                      density="compact"
                      rowHeight={40}
                      columnHeaderHeight={40}
                      rows={listData.items}
                      columns={listColumns}
                      getRowId={(row) => row.id}
                      loading={listLoading || isNavigating}
                      disableRowSelectionOnClick
                      pagination
                      paginationMode="server"
                      paginationModel={paginationModel}
                      onPaginationModelChange={updateListPaginationModel}
                      pageSizeOptions={[10, 25, 50]}
                      sortingMode="server"
                      sortModel={sortModel}
                      onSortModelChange={updateListSortModel}
                      rowCount={listData.totalCount}
                      onRowDoubleClick={(params) =>
                        startNavigation(() => setScreen({ kind: "details", vpsId: params.row.id }))
                      }
                      sx={{
                        border: 0,
                        "& .MuiDataGrid-cell": {
                          py: 0.5,
                        },
                        "& .MuiDataGrid-columnHeaderTitle": {
                          fontSize: "0.79rem",
                          fontWeight: 700,
                        },
                        "& .MuiDataGrid-cell, & .MuiDataGrid-footerContainer": {
                          fontSize: "0.84rem",
                        },
                        "& .MuiDataGrid-columnHeaders": {
                          borderBottom: "1px solid rgba(28, 25, 23, 0.08)",
                        },
                      }}
                      slots={{
                        noRowsOverlay: () => (
                          <EmptyState
                            title="No VPS records yet"
                            body="Add the first endpoint to start tracking controllers."
                            action={
                              <Button
                                variant="contained"
                                startIcon={<AddRoundedIcon />}
                                onClick={() => setScreen({ kind: "create" })}
                              >
                                Add VPS
                              </Button>
                            }
                          />
                        ),
                      }}
                    />
                  </Box>
                </CardContent>
              </Card>
            </Stack>
          ) : null}

          {screen.kind === "details" ? (
            selectedVps ? (
              <Stack spacing={1.5}>
                <Box
                  sx={{
                    display: "grid",
                    gap: 1.25,
                    gridTemplateColumns: { xs: "1fr", xl: "1.1fr 0.9fr" },
                  }}
                >
                  <Card>
                    <CardContent>
                      <Stack spacing={1.5}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Typography variant="h5">{selectedVps.name}</Typography>
                          <Chip
                            label={selectedVps.status}
                            color={statusColor(selectedVps.status)}
                          />
                          {!selectedVps.isEnabled ? <Chip label="disabled" /> : null}
                          {selectedVps.timestampWarnings.length > 0 ? (
                            <Tooltip title={`Fallback timestamps: ${selectedVps.timestampWarnings.join(", ")}`}>
                              <Chip size="small" label="legacy timestamps" color="warning" variant="outlined" />
                            </Tooltip>
                          ) : null}
                        </Stack>
                        <Typography color="text.secondary">{selectedVps.statusReason}</Typography>
                        <Divider />
                        <Box
                          sx={{
                            display: "grid",
                            gap: 1.5,
                            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
                          }}
                        >
                          <DetailField label="Endpoint" value={`${selectedVps.protocol}://${selectedVps.host}:${selectedVps.port}`} />
                          <DetailField label="Provider" value={selectedVps.provider} />
                          <DetailField label="Environment" value={selectedVps.environment} />
                          <DetailField label="Region" value={selectedVps.region || "-"} />
                          <DetailField
                            label="Controller secret"
                            value={
                              selectedVps.hasControllerSecret
                                ? selectedVps.controllerSecretKeyMasked
                                : "Not configured"
                            }
                          />
                          <DetailField label="Last seen" value={formatDateTime(selectedVps.lastSeenAt)} />
                          <DetailField
                            label="Last health check"
                            value={formatDateTime(selectedVps.lastHealthCheckAt)}
                          />
                          <DetailField
                            label="Health result"
                            value={selectedVps.lastHealthCheckResult}
                          />
                          <DetailField
                            label="Controller version"
                            value={selectedVps.controllerVersion || "-"}
                          />
                          <DetailField label="Created by" value={selectedVps.createdBy} />
                          <DetailField label="Updated by" value={selectedVps.updatedBy} />
                        </Box>
                        <Box>
                          <Typography variant="subtitle2" color="text.secondary">
                            Tags
                          </Typography>
                          <Stack direction="row" spacing={0.75} flexWrap="wrap" sx={{ mt: 0.75 }}>
                            {selectedVps.tags.length > 0 ? (
                              selectedVps.tags.map((tag) => <Chip key={tag} label={tag} variant="outlined" />)
                            ) : (
                              <Typography color="text.secondary">No tags</Typography>
                            )}
                          </Stack>
                        </Box>
                        <Box>
                          <Typography variant="subtitle2" color="text.secondary">
                            Notes
                          </Typography>
                          <Typography sx={{ mt: 0.75, whiteSpace: "pre-wrap" }}>
                            {selectedVps.notes || "No operator notes recorded."}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Button
                            variant="contained"
                            startIcon={<EditRoundedIcon />}
                            onClick={() => setScreen({ kind: "edit", vpsId: selectedVps.id })}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outlined"
                            startIcon={<PlayArrowRoundedIcon />}
                            disabled={actionVpsId === selectedVps.id || !selectedVps.isEnabled}
                            onClick={() => openExecuteScriptDialog(selectedVps)}
                          >
                            Execute script
                          </Button>
                          <Button
                            variant="outlined"
                            startIcon={<LanRoundedIcon />}
                            disabled={actionVpsId === selectedVps.id}
                            onClick={() => void triggerProbe(selectedVps.id, "test-connection")}
                          >
                            Test connection
                          </Button>
                          <Button
                            variant="outlined"
                            startIcon={<SyncRoundedIcon />}
                            disabled={actionVpsId === selectedVps.id}
                            onClick={() => void triggerProbe(selectedVps.id, "health-check")}
                          >
                            Health check
                          </Button>
                          <Button
                            variant="outlined"
                            startIcon={<HistoryRoundedIcon />}
                            onClick={() => setScreen({ kind: "logs", vpsId: selectedVps.id })}
                          >
                            Open logs
                          </Button>
                          <Button
                            variant="text"
                            color="error"
                            startIcon={<DeleteOutlineRoundedIcon />}
                            onClick={() => setDeleteTarget(selectedVps)}
                          >
                            Delete
                          </Button>
                        </Stack>
                      </Stack>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent>
                      <Typography variant="h6">Recent interaction history</Typography>
                      <Typography color="text.secondary" sx={{ mt: 0.35, mb: 1 }}>
                        Latest request and failure events.
                      </Typography>
                      {detailLogs.length === 0 ? (
                        <EmptyState
                          title="No interaction logs yet"
                          body="Run a test or health check to create log entries."
                        />
                      ) : (
                        <Stack spacing={0.75}>
                          {detailLogs.map((log) => (
                            <Paper
                              key={log.id}
                              variant="outlined"
                              sx={{ p: 1.25, borderRadius: "7px", cursor: "pointer" }}
                              onClick={() => setScreen({ kind: "logs", vpsId: selectedVps.id })}
                            >
                              <Stack direction="row" justifyContent="space-between" spacing={2}>
                                <Box>
                                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                    <Chip
                                      label={log.result}
                                      color={resultColor(log.result)}
                                      size="small"
                                    />
                                    <Typography variant="subtitle2">{log.interactionType}</Typography>
                                    <Typography color="text.secondary">{log.requestPath}</Typography>
                                  </Stack>
                                  <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                                    {log.errorMessage || "Completed without reported transport errors."}
                                  </Typography>
                                </Box>
                                <Typography color="text.secondary">
                                  {formatDateTime(log.createdAt)}
                                </Typography>
                              </Stack>
                            </Paper>
                          ))}
                        </Stack>
                      )}
                    </CardContent>
                  </Card>
                </Box>
              </Stack>
            ) : (
              <EmptyState
                title="VPS record unavailable"
                body="The selected record could not be loaded. Refresh the registry or return to the list."
              />
            )
          ) : null}

          {screen.kind === "logs" ? (
            selectedVps ? (
              <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0 }}>
                <Card>
                  <CardContent>
                    <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5}>
                      <FormControl sx={{ minWidth: 180 }}>
                        <InputLabel id="log-result-filter-label">Result</InputLabel>
                        <Select
                          labelId="log-result-filter-label"
                          value={logResultFilter}
                          label="Result"
                          onChange={(event) => {
                            setLogResultFilter(String(event.target.value));
                            setLogsPaginationModel((current) => ({ ...current, page: 0 }));
                          }}
                        >
                          <MenuItem value="">All results</MenuItem>
                          {logResultOptions.map((option) => (
                            <MenuItem key={option} value={option}>
                              {option}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl sx={{ minWidth: 220 }}>
                        <InputLabel id="log-type-filter-label">Interaction type</InputLabel>
                        <Select
                          labelId="log-type-filter-label"
                          value={logTypeFilter}
                          label="Interaction type"
                          onChange={(event) => {
                            setLogTypeFilter(String(event.target.value));
                            setLogsPaginationModel((current) => ({ ...current, page: 0 }));
                          }}
                        >
                          <MenuItem value="">All types</MenuItem>
                          {logInteractionTypeOptions.map((option) => (
                            <MenuItem key={option} value={option}>
                              {option}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <TextField
                        label="Start"
                        type="datetime-local"
                        value={logStartAt}
                        onChange={(event) => {
                          setLogStartAt(event.target.value);
                          setLogsPaginationModel((current) => ({ ...current, page: 0 }));
                        }}
                        InputLabelProps={{ shrink: true }}
                      />
                      <TextField
                        label="End"
                        type="datetime-local"
                        value={logEndAt}
                        onChange={(event) => {
                          setLogEndAt(event.target.value);
                          setLogsPaginationModel((current) => ({ ...current, page: 0 }));
                        }}
                        InputLabelProps={{ shrink: true }}
                      />
                    </Stack>
                  </CardContent>
                </Card>

                <Card sx={{ flex: 1, minHeight: 0 }}>
                  <CardContent sx={{ height: "100%", p: 1.25, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
                      <Button
                        color="error"
                        variant="outlined"
                        disabled={!selectedVps || logsLoading || logsData.totalCount === 0}
                        onClick={() => selectedVps && setClearLogsTarget(selectedVps)}
                      >
                        Clear Log
                      </Button>
                    </Stack>
                    {logsError ? <Alert severity="error">{logsError}</Alert> : null}
                    <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                      <DataGridPremium
                        density="compact"
                        rowHeight={40}
                        columnHeaderHeight={40}
                        rows={logsData.items}
                        columns={logColumns}
                        getRowId={(row) => row.id}
                        loading={logsLoading}
                        disableRowSelectionOnClick
                        pagination
                        paginationMode="server"
                        paginationModel={logsPaginationModel}
                        onPaginationModelChange={updateLogsPaginationModel}
                        pageSizeOptions={[10, 20, 50]}
                        rowCount={logsData.totalCount}
                        onRowClick={(params: GridRowParams<RemoteVpsInteractionLogRecord>) =>
                          void refreshSelectedLog(params.row)
                        }
                        sx={{
                          border: 0,
                          height: "100%",
                          "& .MuiDataGrid-cell": {
                            py: 0.5,
                          },
                          "& .MuiDataGrid-columnHeaderTitle": {
                            fontSize: "0.79rem",
                            fontWeight: 700,
                          },
                          "& .MuiDataGrid-cell, & .MuiDataGrid-footerContainer": {
                            fontSize: "0.84rem",
                          },
                          "& .MuiDataGrid-main": {
                            minHeight: 0,
                          },
                          "& .MuiDataGrid-virtualScroller": {
                            overflowY: "auto",
                          },
                        }}
                        slots={{
                          noRowsOverlay: () => (
                            <EmptyState
                              title="No logs match the current filters"
                              body="Broaden filters or run a fresh test."
                            />
                          ),
                        }}
                      />
                    </Box>
                  </CardContent>
                </Card>
              </Stack>
            ) : (
              <EmptyState
                title="Unable to load VPS logs"
                body="The selected record is unavailable."
              />
            )
          ) : null}
        </Box>
      </Box>

      <Dialog open={Boolean(selectedLog)} onClose={() => setSelectedLog(null)} maxWidth="md" fullWidth>
        <DialogTitle>Interaction details</DialogTitle>
        <DialogContent dividers>
          {selectedLog ? (
            <Stack spacing={2}>
              {(() => {
                const engine = getInteractionEngineInfo(selectedLog);

                return (
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Chip label={selectedLog.result} color={resultColor(selectedLog.result)} />
                    <Chip label={selectedLog.direction} variant="outlined" />
                    <Chip label={selectedLog.interactionType} variant="outlined" />
                    {engine.requestedMode ? (
                      <Chip
                        label={getTaskEngineLabel(engine.requestedMode)}
                        color={engine.requestedMode === "ai_driven" ? "warning" : "default"}
                        variant={engine.requestedMode === "ai_driven" ? "filled" : "outlined"}
                      />
                    ) : null}
                  </Stack>
                );
              })()}
              <DetailField label="Timestamp" value={formatDateTime(selectedLog.createdAt)} />
              <DetailField label="Request" value={`${selectedLog.requestMethod} ${selectedLog.requestPath}`} />
              <DetailField label="Correlation ID" value={selectedLog.correlationId} />
              <DetailField
                label="HTTP status"
                value={selectedLog.responseStatusCode?.toString() ?? "-"}
              />
              <DetailField label="Duration" value={formatDuration(selectedLog.durationMs)} />
              <DetailField label="Error" value={selectedLog.errorMessage || "-"} />
              <DetailField
                label="Engine mode"
                value={getTaskEngineLabel(getInteractionEngineInfo(selectedLog).requestedMode)}
              />
              <DetailField
                label="Engine resolver"
                value={getInteractionEngineInfo(selectedLog).resolver || "-"}
              />
              <DetailField
                label="Step resolution"
                value={getTaskStepResolutionSummary(selectedLog.responsePayload) || "-"}
              />
              <DetailField label="Task summary" value={getTaskResultSummary(selectedLog.responsePayload) || "-"} />
              <PayloadBlock title="Request payload" value={selectedLog.requestPayload} />
              <PayloadBlock title="Response payload" value={selectedLog.responsePayload} />
              {formatTaskStepResolutionIndicators(selectedLog.responsePayload).length > 0 ? (
                <StepResolutionBlock
                  title="Step resolution indicators"
                  items={formatTaskStepResolutionIndicators(selectedLog.responsePayload)}
                />
              ) : null}
              {getTaskLogText(selectedLog.responsePayload) ? (
                <PayloadBlock title="Task log" value={getTaskLogText(selectedLog.responsePayload)} />
              ) : null}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedLog(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(executeDialogVps)}
        onClose={() => {
          if (!isExecutingScript) {
            setExecuteDialogVps(null);
          }
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Execute Script</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography color="text.secondary">
              {executeDialogVps
                ? `Select a script to run on ${executeDialogVps.name}.`
                : "Select a script to run on the chosen VPS."}
            </Typography>

            {scriptsError ? <Alert severity="error">{scriptsError}</Alert> : null}
            {executeDialogError ? <Alert severity="error">{executeDialogError}</Alert> : null}

            <FormControl fullWidth disabled={scriptsLoading || isExecutingScript}>
              <InputLabel id="execute-script-select-label">Script</InputLabel>
              <Select
                labelId="execute-script-select-label"
                value={selectedScriptId}
                label="Script"
                onChange={(event) => setSelectedScriptId(String(event.target.value))}
              >
                {availableScripts.map((script) => (
                  <MenuItem key={script.id} value={script.id}>
                    {script.name}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>
                {scriptsLoading
                  ? "Loading available scripts..."
                  : availableScripts.length === 0
                    ? "No enabled scripts are available."
                    : "The selected script will be dispatched to the remote controller and tracked every 4 seconds."}
              </FormHelperText>
            </FormControl>

            {selectedScript ? (
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Engine mode
                </Typography>
                <Typography sx={{ mt: 0.5 }}>
                  {selectedScript.engineMode === "ai_driven"
                    ? "AI-driven execution. rc uses AI to choose among bounded snapshot candidates, keeps browser actions deterministic, and falls back to deterministic matching only if AI selection is unavailable or unusable."
                    : "Deterministic execution."}
                </Typography>
              </Box>
            ) : null}

            {selectedScript ? (
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Description
                </Typography>
                <Typography sx={{ mt: 0.5 }}>
                  {selectedScript.description || "No description provided."}
                </Typography>
              </Box>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExecuteDialogVps(null)} disabled={isExecutingScript}>
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={<PlayArrowRoundedIcon />}
            onClick={() => void executeSelectedScript()}
            disabled={isExecutingScript || scriptsLoading || !selectedScriptId}
          >
            Execute
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete VPS record</DialogTitle>
        <DialogContent dividers>
          <Typography>
            {deleteTarget
              ? `Delete ${deleteTarget.name} from the active registry? The record will be soft deleted and interaction logs will remain available until the retention window expires.`
              : ""}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void confirmDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(clearLogsTarget)} onClose={() => setClearLogsTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Clear interaction logs</DialogTitle>
        <DialogContent dividers>
          <Typography>
            {clearLogsTarget
              ? `Delete all interaction log records for ${clearLogsTarget.name}? This cannot be undone.`
              : ""}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearLogsTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void confirmClearLogs()}>
            Clear Log
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        message={snackbar}
      />
    </Box>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ mt: 0.75 }}>{value}</Typography>
    </Box>
  );
}

function PayloadBlock({ title, value }: { title: string; value: unknown }) {
  const serializedValue = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary">
        {title}
      </Typography>
      <Paper
        variant="outlined"
        sx={{ mt: 0.5, p: 1.25, borderRadius: "7px", backgroundColor: "rgba(28, 25, 23, 0.02)" }}
      >
        <Typography
          component="pre"
          sx={{ m: 0, overflowX: "auto", fontFamily: "var(--font-ibm-plex-mono), monospace" }}
        >
          {serializedValue}
        </Typography>
      </Paper>
    </Box>
  );
}

function StepResolutionBlock({
  title,
  items,
}: {
  title: string;
  items: Array<{
    order: number;
    kind: string;
    resolver: string;
    usedAi: boolean;
    fallbackReason: string | null;
    instruction: string;
  }>;
}) {
  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary">
        {title}
      </Typography>
      <Stack spacing={1} sx={{ mt: 0.5 }}>
        {items.map((item) => (
          <Paper
            key={`${item.order}-${item.kind}-${item.resolver}`}
            variant="outlined"
            sx={{
              p: 1.25,
              borderRadius: "7px",
              backgroundColor: "rgba(28, 25, 23, 0.02)",
            }}
          >
            <Stack spacing={0.75}>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`Step ${item.order}`} variant="outlined" />
                <Chip size="small" label={item.kind} variant="outlined" />
                <Chip
                  size="small"
                  label={resolutionChipLabel(item.resolver)}
                  color={resolutionChipColor(item.resolver)}
                  variant={item.resolver === "deterministic" ? "outlined" : "filled"}
                />
                {item.usedAi ? <Chip size="small" label="AI selected" color="warning" /> : null}
                {item.fallbackReason ? (
                  <Chip size="small" label={`reason: ${item.fallbackReason}`} color="info" variant="outlined" />
                ) : null}
              </Stack>
              <Typography sx={{ fontSize: "0.92rem" }}>
                {item.instruction || "No instruction text recorded."}
              </Typography>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Box>
  );
}
