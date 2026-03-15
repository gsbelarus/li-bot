"use client";

import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import LanRoundedIcon from "@mui/icons-material/LanRounded";
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
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
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
  tags: string;
  notes: string;
  isEnabled: boolean;
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
      spacing={2}
      sx={{ height: "100%", px: 3, textAlign: "center" }}
    >
      <Box
        sx={{
          width: 72,
          height: 72,
          borderRadius: "24px",
          background:
            "radial-gradient(circle at top, rgba(14, 98, 81, 0.18), rgba(14, 98, 81, 0.04))",
          display: "grid",
          placeItems: "center",
        }}
      >
        <LanRoundedIcon color="primary" />
      </Box>
      <Typography variant="h5">{title}</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 420 }}>
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
        const payload = {
          ...values,
          port: Number(values.port),
          tags: values.tags,
        };
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
      <CardContent sx={{ p: 4 }}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h4">
              {mode === "create" ? "Register VPS" : `Edit ${record?.name ?? "VPS"}`}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Capture connection details, grouping tags, and operational notes.
            </Typography>
          </Box>

          {errors.form ? <Alert severity="error">{errors.form}</Alert> : null}

          <Box
            sx={{
              display: "grid",
              gap: 2,
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
  const [actionVpsId, setActionVpsId] = useState<string | null>(null);
  const [isNavigating, startNavigation] = useTransition();
  const [refreshToken, setRefreshToken] = useState(0);

  function updateListPaginationModel(nextModel: GridPaginationModel) {
    queueMicrotask(() => {
      setPaginationModel((current) => {
        if (
          current.page === nextModel.page &&
          current.pageSize === nextModel.pageSize
        ) {
          return current;
        }

        return nextModel;
      });
    });
  }

  function updateListSortModel(nextModel: GridSortModel) {
    queueMicrotask(() => {
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
    });
  }

  function updateLogsPaginationModel(nextModel: GridPaginationModel) {
    queueMicrotask(() => {
      setLogsPaginationModel((current) => {
        if (
          current.page === nextModel.page &&
          current.pageSize === nextModel.pageSize
        ) {
          return current;
        }

        return nextModel;
      });
    });
  }

  const activeVpsId =
    screen.kind === "edit" || screen.kind === "details" || screen.kind === "logs"
      ? screen.vpsId
      : null;

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
        minWidth: 130,
        renderCell: ({ row }) => (
          <Chip label={row.status} color={statusColor(row.status)} size="small" />
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
      ? "Register a controller endpoint in the control plane."
      : screen.kind === "edit"
        ? "Update connection settings and operator metadata."
        : screen.kind === "details"
          ? "Inspect metadata, health posture, and recent events."
          : screen.kind === "logs"
            ? "Review request, response, timeout, and transport history."
            : "Manage remote controller endpoints, search the registry, and inspect operational health.";

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", backgroundColor: "background.default" }}>
      <Box
        component="aside"
        sx={{
          width: 280,
          flexShrink: 0,
          borderRight: "1px solid rgba(28, 25, 23, 0.08)",
          background:
            "linear-gradient(180deg, rgba(255, 250, 242, 0.96), rgba(247, 239, 223, 0.9))",
          p: 3,
          display: { xs: "none", md: "flex" },
          flexDirection: "column",
          gap: 3,
        }}
      >
        <Box sx={{ pb: 2.5, borderBottom: "1px solid rgba(28, 25, 23, 0.08)" }}>
          <Typography variant="overline" color="primary.main">
            Control Center
          </Typography>
          <Typography variant="h4" sx={{ mt: 0.5 }}>
            Remote Fleet
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            One registry for controller endpoints, diagnostics, and operator notes.
          </Typography>
        </Box>

        <List sx={{ p: 0 }}>
          <ListItemButton
            selected
            sx={{
              mb: 1,
              px: 0,
              borderRadius: 0,
              bgcolor: "transparent",
              "&.Mui-selected": {
                bgcolor: "transparent",
              },
              "&.Mui-selected:hover": {
                bgcolor: "transparent",
              },
            }}
          >
            <ListItemText primary="Remote VPS" secondary="Registry and diagnostics" />
          </ListItemButton>
        </List>

        <Box
          sx={{
            mt: "auto",
            pt: 2.5,
            borderTop: "1px solid rgba(28, 25, 23, 0.08)",
          }}
        >
          <Typography variant="subtitle2">Registry posture</Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {listData.totalCount} active records tracked with retained interaction history.
          </Typography>
        </Box>
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Box
          sx={{
            px: { xs: 2, md: 4 },
            py: 3,
            display: "flex",
            justifyContent: "space-between",
            alignItems: { xs: "flex-start", md: "center" },
            gap: 2,
            flexWrap: "wrap",
          }}
        >
          <Box>
            <Typography variant="h3">{currentTitle}</Typography>
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 680 }}>
              {currentSubtitle}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1.5} alignItems="center">
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

        <Box sx={{ flex: 1, minHeight: 0, px: { xs: 2, md: 4 }, pb: 4 }}>
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
            <RemoteVpsFormScreen
              key={`edit-${screen.vpsId}`}
              mode="edit"
              record={selectedVps}
              onCancel={() => setScreen({ kind: "details", vpsId: screen.vpsId })}
              onSaved={(item, message) => {
                setSnackbar(message);
                setRefreshToken((value) => value + 1);
                setScreen({ kind: "details", vpsId: item.id });
              }}
            />
          ) : null}

          {screen.kind === "list" ? (
            <Stack spacing={2} sx={{ height: "100%" }}>
              <Card>
                <CardContent>
                  <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
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
                <CardContent sx={{ height: "100%", p: 1.5 }}>
                  {listError ? <Alert severity="error">{listError}</Alert> : null}
                  <Box sx={{ height: "100%" }}>
                    <DataGridPremium
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
                        "& .MuiDataGrid-columnHeaders": {
                          borderBottom: "1px solid rgba(28, 25, 23, 0.08)",
                        },
                      }}
                      slots={{
                        noRowsOverlay: () => (
                          <EmptyState
                            title="No VPS records yet"
                            body="Create the first registry entry to start tracking remote controllers and their communication history."
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
              <Stack spacing={2}>
                <Box
                  sx={{
                    display: "grid",
                    gap: 2,
                    gridTemplateColumns: { xs: "1fr", xl: "1.1fr 0.9fr" },
                  }}
                >
                  <Card>
                    <CardContent>
                      <Stack spacing={2.5}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Typography variant="h4">{selectedVps.name}</Typography>
                          <Chip
                            label={selectedVps.status}
                            color={statusColor(selectedVps.status)}
                          />
                          {!selectedVps.isEnabled ? <Chip label="disabled" /> : null}
                        </Stack>
                        <Typography color="text.secondary">{selectedVps.statusReason}</Typography>
                        <Divider />
                        <Box
                          sx={{
                            display: "grid",
                            gap: 2,
                            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
                          }}
                        >
                          <DetailField label="Endpoint" value={`${selectedVps.protocol}://${selectedVps.host}:${selectedVps.port}`} />
                          <DetailField label="Provider" value={selectedVps.provider} />
                          <DetailField label="Environment" value={selectedVps.environment} />
                          <DetailField label="Region" value={selectedVps.region || "-"} />
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
                          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
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
                          <Typography sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
                            {selectedVps.notes || "No operator notes recorded."}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1.5} flexWrap="wrap">
                          <Button
                            variant="contained"
                            startIcon={<EditRoundedIcon />}
                            onClick={() => setScreen({ kind: "edit", vpsId: selectedVps.id })}
                          >
                            Edit
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
                      <Typography variant="h5">Recent interaction history</Typography>
                      <Typography color="text.secondary" sx={{ mt: 1, mb: 2 }}>
                        The latest request, response, and failure events linked to this VPS.
                      </Typography>
                      {detailLogs.length === 0 ? (
                        <EmptyState
                          title="No interaction logs yet"
                          body="Run a manual test or health check to populate the communication trail."
                        />
                      ) : (
                        <Stack spacing={1.5}>
                          {detailLogs.map((log) => (
                            <Paper
                              key={log.id}
                              variant="outlined"
                              sx={{ p: 2, borderRadius: 4, cursor: "pointer" }}
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
                                  <Typography color="text.secondary" sx={{ mt: 1 }}>
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
              <Stack spacing={2} sx={{ height: "100%" }}>
                <Card>
                  <CardContent>
                    <Stack direction={{ xs: "column", lg: "row" }} spacing={2}>
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
                  <CardContent sx={{ height: "100%", p: 1.5 }}>
                    {logsError ? <Alert severity="error">{logsError}</Alert> : null}
                    <Box sx={{ height: "100%" }}>
                      <DataGridPremium
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
                        sx={{ border: 0 }}
                        slots={{
                          noRowsOverlay: () => (
                            <EmptyState
                              title="No logs match the current filters"
                              body="Broaden the time range or run a fresh test to capture new controller interactions."
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
                body="The selected VPS record is unavailable, so the interaction history could not be opened."
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
              <Stack direction="row" spacing={1} flexWrap="wrap">
                <Chip label={selectedLog.result} color={resultColor(selectedLog.result)} />
                <Chip label={selectedLog.direction} variant="outlined" />
                <Chip label={selectedLog.interactionType} variant="outlined" />
              </Stack>
              <DetailField label="Timestamp" value={formatDateTime(selectedLog.createdAt)} />
              <DetailField label="Request" value={`${selectedLog.requestMethod} ${selectedLog.requestPath}`} />
              <DetailField label="Correlation ID" value={selectedLog.correlationId} />
              <DetailField
                label="HTTP status"
                value={selectedLog.responseStatusCode?.toString() ?? "-"}
              />
              <DetailField label="Duration" value={formatDuration(selectedLog.durationMs)} />
              <DetailField label="Error" value={selectedLog.errorMessage || "-"} />
              <PayloadBlock title="Request payload" value={selectedLog.requestPayload} />
              <PayloadBlock title="Response payload" value={selectedLog.responsePayload} />
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedLog(null)}>Close</Button>
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
  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary">
        {title}
      </Typography>
      <Paper
        variant="outlined"
        sx={{ mt: 1, p: 2, borderRadius: 4, backgroundColor: "rgba(28, 25, 23, 0.02)" }}
      >
        <Typography
          component="pre"
          sx={{ m: 0, overflowX: "auto", fontFamily: "var(--font-ibm-plex-mono), monospace" }}
        >
          {JSON.stringify(value ?? null, null, 2)}
        </Typography>
      </Paper>
    </Box>
  );
}
