"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import CodeMirror from "@uiw/react-codemirror";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ContentCopyRoundedIcon from "@mui/icons-material/ContentCopyRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import HistoryRoundedIcon from "@mui/icons-material/HistoryRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import {
  DataGridPremium,
  GridColDef,
  GridPaginationModel,
  GridRowParams,
} from "@mui/x-data-grid-premium";
import { json } from "@codemirror/lang-json";

import { ControlCenterSidebar } from "@/components/control-center-sidebar";
import { controlCenterSections } from "@/lib/control-center-navigation";
import {
  SystemLogBulkDeleteResponse,
  SystemLogListResponse,
  SystemLogRecord,
} from "@/lib/remote-vps-shared";

type ScreenState = { kind: "list" } | { kind: "details"; logId: string };

const operatorId = "operator@control-center";
const defaultPaginationModel: GridPaginationModel = { page: 0, pageSize: 20 };

type LogsUrlState = {
  page: number;
  pageSize: number;
  vpsId: string;
  scriptName: string;
  search: string;
  startAt: string;
  endAt: string;
  scriptResultsOnly: boolean;
  logId: string | null;
};

type ActiveFilterChip = {
  key: string;
  label: string;
  onDelete: () => void;
};

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function readLogsUrlState(searchParams: { get(name: string): string | null }): LogsUrlState {
  return {
    page: parsePositiveInt(searchParams.get("page"), 1),
    pageSize: parsePositiveInt(searchParams.get("pageSize"), defaultPaginationModel.pageSize),
    vpsId: searchParams.get("vpsId") || "",
    scriptName: searchParams.get("scriptName") || "",
    search: searchParams.get("search") || "",
    startAt: searchParams.get("startAt") || "",
    endAt: searchParams.get("endAt") || "",
    scriptResultsOnly: searchParams.get("scriptResultsOnly") === "true",
    logId: searchParams.get("logId") || null,
  };
}

function isStructuredValue(value: unknown) {
  return typeof value === "object" && value !== null;
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDateTimeInputValue(value: string) {
  if (!value) {
    return "";
  }

  return value.replace("T", " ");
}

function resultBadgeColor(log: SystemLogRecord) {
  if (log.scriptExecutionResult === "COMPLETED") {
    return "success" as const;
  }

  if (log.scriptExecutionResult === "NOT_COMPLETED") {
    return "warning" as const;
  }

  if (log.scriptExecutionResult === "ALERT") {
    return "error" as const;
  }

  if (log.scriptExecutionResult === "ERROR") {
    return "error" as const;
  }

  switch (log.result) {
    case "success":
      return "success" as const;
    case "pending":
    case "retrying":
      return "info" as const;
    case "timeout":
      return "warning" as const;
    case "failed":
    case "rejected":
      return "error" as const;
    default:
      return "default" as const;
  }
}

function resultBadgeLabel(log: SystemLogRecord) {
  return log.scriptExecutionResult || log.result.toUpperCase();
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

function getApiErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { error?: unknown; details?: unknown };

    if (typeof candidate.error === "string" && candidate.error.trim()) {
      return candidate.error;
    }

    if (typeof candidate.details === "string" && candidate.details.trim()) {
      return candidate.details;
    }
  }

  return fallback;
}

export function SystemLogsControlCenter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlState = useMemo(() => readLogsUrlState(searchParams), [searchParams]);
  const [listData, setListData] = useState<SystemLogListResponse>({
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 20,
    vpsOptions: [],
    scriptOptions: [],
  });
  const [selectedLog, setSelectedLog] = useState<SystemLogRecord | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({
    page: urlState.page - 1,
    pageSize: urlState.pageSize,
  });
  const [vpsFilter, setVpsFilter] = useState(urlState.vpsId);
  const [scriptFilter, setScriptFilter] = useState(urlState.scriptName);
  const [searchInput, setSearchInput] = useState(urlState.search);
  const [search, setSearch] = useState(urlState.search);
  const [startAt, setStartAt] = useState(urlState.startAt);
  const [endAt, setEndAt] = useState(urlState.endAt);
  const [scriptResultsOnly, setScriptResultsOnly] = useState(urlState.scriptResultsOnly);
  const [exportingFormat, setExportingFormat] = useState<"json" | "csv" | null>(null);
  const [clearLogsOpen, setClearLogsOpen] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isNavigating, startNavigation] = useTransition();

  const activeLogId = urlState.logId;
  const screen = useMemo<ScreenState>(
    () => (activeLogId ? { kind: "details", logId: activeLogId } : { kind: "list" }),
    [activeLogId]
  );

  const navigateWithState = useCallback((updates: Partial<LogsUrlState>, mode: "push" | "replace" = "replace") => {
    const nextState: LogsUrlState = {
      ...urlState,
      ...updates,
    };
    const nextParams = new URLSearchParams();

    if (nextState.page !== 1) {
      nextParams.set("page", String(nextState.page));
    }

    if (nextState.pageSize !== defaultPaginationModel.pageSize) {
      nextParams.set("pageSize", String(nextState.pageSize));
    }

    if (nextState.vpsId) {
      nextParams.set("vpsId", nextState.vpsId);
    }

    if (nextState.scriptName) {
      nextParams.set("scriptName", nextState.scriptName);
    }

    if (nextState.search) {
      nextParams.set("search", nextState.search);
    }

    if (nextState.startAt) {
      nextParams.set("startAt", nextState.startAt);
    }

    if (nextState.endAt) {
      nextParams.set("endAt", nextState.endAt);
    }

    if (nextState.scriptResultsOnly) {
      nextParams.set("scriptResultsOnly", "true");
    }

    if (nextState.logId) {
      nextParams.set("logId", nextState.logId);
    }

    const nextHref = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;

    startNavigation(() => {
      if (mode === "push") {
        router.push(nextHref, { scroll: false });
        return;
      }

      router.replace(nextHref, { scroll: false });
    });
  }, [pathname, router, startNavigation, urlState]);

  const buildQueryParams = useCallback((options?: { page?: number; pageSize?: number }) => {
    return new URLSearchParams({
      page: String(options?.page ?? paginationModel.page + 1),
      pageSize: String(options?.pageSize ?? paginationModel.pageSize),
      vpsId: vpsFilter,
      scriptName: scriptFilter,
      search,
      startAt,
      endAt,
      scriptResultsOnly: String(scriptResultsOnly),
    });
  }, [endAt, paginationModel.page, paginationModel.pageSize, scriptFilter, scriptResultsOnly, search, startAt, vpsFilter]);

  const applyListFilter = useCallback((next: { vpsId?: string; scriptName?: string }) => {
    const nextVpsFilter = typeof next.vpsId === "string" ? next.vpsId : vpsFilter;
    const nextScriptFilter = typeof next.scriptName === "string" ? next.scriptName : scriptFilter;

    setVpsFilter(nextVpsFilter);
    setScriptFilter(nextScriptFilter);
    setPaginationModel((current) => ({ ...current, page: 0 }));
    navigateWithState(
      {
        vpsId: nextVpsFilter,
        scriptName: nextScriptFilter,
        page: 1,
      },
      "replace"
    );
  }, [navigateWithState, scriptFilter, vpsFilter]);

  const clearListFilters = useCallback(() => {
    setPaginationModel(defaultPaginationModel);
    setVpsFilter("");
    setScriptFilter("");
    setSearchInput("");
    setSearch("");
    setStartAt("");
    setEndAt("");
    setScriptResultsOnly(false);
    navigateWithState(
      {
        page: 1,
        pageSize: defaultPaginationModel.pageSize,
        vpsId: "",
        scriptName: "",
        search: "",
        startAt: "",
        endAt: "",
        scriptResultsOnly: false,
        logId: null,
      },
      "replace"
    );
  }, [navigateWithState]);

  const clearSearchFilter = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setPaginationModel((current) => ({ ...current, page: 0 }));
    navigateWithState({ search: "", page: 1 }, "replace");
  }, [navigateWithState]);

  const hasActiveListState =
    paginationModel.page !== defaultPaginationModel.page ||
    paginationModel.pageSize !== defaultPaginationModel.pageSize ||
    Boolean(vpsFilter || scriptFilter || search || startAt || endAt || scriptResultsOnly);
  const isSearchPending = searchInput !== search;

  const selectedVpsLabel = useMemo(
    () => listData.vpsOptions.find((option) => option.value === vpsFilter)?.label || vpsFilter,
    [listData.vpsOptions, vpsFilter]
  );

  const activeFilterSummary = useMemo<ActiveFilterChip[]>(() => {
    const items: ActiveFilterChip[] = [];

    if (search) {
      items.push({
        key: "search",
        label: `Message: ${search}`,
        onDelete: clearSearchFilter,
      });
    }

    if (vpsFilter) {
      items.push({
        key: "vpsId",
        label: `VPS: ${selectedVpsLabel}`,
        onDelete: () => {
          setVpsFilter("");
          setPaginationModel((current) => ({ ...current, page: 0 }));
          navigateWithState({ vpsId: "", page: 1 }, "replace");
        },
      });
    }

    if (scriptFilter) {
      items.push({
        key: "scriptName",
        label: `Script: ${scriptFilter}`,
        onDelete: () => {
          setScriptFilter("");
          setPaginationModel((current) => ({ ...current, page: 0 }));
          navigateWithState({ scriptName: "", page: 1 }, "replace");
        },
      });
    }

    if (startAt) {
      items.push({
        key: "startAt",
        label: `From: ${formatDateTimeInputValue(startAt)}`,
        onDelete: () => {
          setStartAt("");
          setPaginationModel((current) => ({ ...current, page: 0 }));
          navigateWithState({ startAt: "", page: 1 }, "replace");
        },
      });
    }

    if (endAt) {
      items.push({
        key: "endAt",
        label: `To: ${formatDateTimeInputValue(endAt)}`,
        onDelete: () => {
          setEndAt("");
          setPaginationModel((current) => ({ ...current, page: 0 }));
          navigateWithState({ endAt: "", page: 1 }, "replace");
        },
      });
    }

    if (scriptResultsOnly) {
      items.push({
        key: "scriptResultsOnly",
        label: "Mode: Script results only",
        onDelete: () => {
          setScriptResultsOnly(false);
          setPaginationModel((current) => ({ ...current, page: 0 }));
          navigateWithState({ scriptResultsOnly: false, page: 1 }, "replace");
        },
      });
    }

    if (paginationModel.pageSize !== defaultPaginationModel.pageSize) {
      items.push({
        key: "pageSize",
        label: `Page size: ${paginationModel.pageSize}`,
        onDelete: () => {
          setPaginationModel({ page: 0, pageSize: defaultPaginationModel.pageSize });
          navigateWithState(
            {
              page: 1,
              pageSize: defaultPaginationModel.pageSize,
            },
            "replace"
          );
        },
      });
    }

    return items;
  }, [clearSearchFilter, endAt, navigateWithState, paginationModel.pageSize, scriptFilter, scriptResultsOnly, search, selectedVpsLabel, startAt, vpsFilter]);

  useEffect(() => {
    setPaginationModel((current) => {
      const nextPage = urlState.page - 1;

      if (current.page === nextPage && current.pageSize === urlState.pageSize) {
        return current;
      }

      return {
        page: nextPage,
        pageSize: urlState.pageSize,
      };
    });

    setVpsFilter((current) => (current === urlState.vpsId ? current : urlState.vpsId));
    setScriptFilter((current) => (current === urlState.scriptName ? current : urlState.scriptName));
    setSearchInput((current) => (current === urlState.search ? current : urlState.search));
    setSearch((current) => (current === urlState.search ? current : urlState.search));
    setStartAt((current) => (current === urlState.startAt ? current : urlState.startAt));
    setEndAt((current) => (current === urlState.endAt ? current : urlState.endAt));
    setScriptResultsOnly((current) =>
      current === urlState.scriptResultsOnly ? current : urlState.scriptResultsOnly
    );
  }, [urlState]);

  useEffect(() => {
    if (searchInput === search) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSearch(searchInput);
      setPaginationModel((current) => ({ ...current, page: 0 }));
      navigateWithState({ search: searchInput, page: 1 }, "replace");
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [navigateWithState, search, searchInput]);

  async function exportLogs(format: "json" | "csv") {
    setExportingFormat(format);

    try {
      const response = await fetch(`/api/logs/export?${buildQueryParams({ page: 1, pageSize: 100 }).toString()}&format=${format}`, {
        headers: {
          "x-operator-id": operatorId,
        },
      });

      if (!response.ok) {
        throw new Error("Export failed.");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const disposition = response.headers.get("content-disposition") || "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);

      anchor.href = url;
      anchor.download = fileNameMatch?.[1] || `system-logs.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setExportingFormat(null);
    }
  }

  async function clearFilteredLogs() {
    setClearingLogs(true);

    try {
      const params = buildQueryParams({ page: 1, pageSize: defaultPaginationModel.pageSize });
      const response = await requestJson<SystemLogBulkDeleteResponse>(`/api/logs?${params.toString()}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      });

      setClearLogsOpen(false);
      setSelectedLog(null);
      setListData((current) => ({
        ...current,
        items: [],
        totalCount: 0,
      }));
      setPaginationModel((current) => ({ ...current, page: 0 }));
      setRefreshToken((current) => current + 1);
      navigateWithState({ page: 1, logId: null }, "replace");
      setSnackbar(response.message);
    } catch (error) {
      setSnackbar(getApiErrorMessage(error, "Unable to clear log records."));
    } finally {
      setClearingLogs(false);
    }
  }

  function refreshScreen() {
    setRefreshToken((current) => current + 1);
  }

  useEffect(() => {
    if (activeLogId) {
      return;
    }

    let ignore = false;

    async function loadLogs() {
      setListLoading(true);
      setListError(null);

      try {
        const params = buildQueryParams();
        const response = await requestJson<SystemLogListResponse>(`/api/logs?${params.toString()}`);

        if (!ignore) {
          setListData(response);
        }
      } catch {
        if (!ignore) {
          setListError("Unable to load system logs.");
        }
      } finally {
        if (!ignore) {
          setListLoading(false);
        }
      }
    }

    void loadLogs();

    return () => {
      ignore = true;
    };
  }, [activeLogId, buildQueryParams, refreshToken]);

  useEffect(() => {
    if (!activeLogId) {
      setSelectedLog(null);
      setDetailError(null);
      return;
    }

    let ignore = false;

    async function loadLog() {
      setDetailLoading(true);
      setDetailError(null);

      try {
        const response = await requestJson<{ item: SystemLogRecord }>(`/api/logs/${activeLogId}`);

        if (!ignore) {
          setSelectedLog(response.item);
        }
      } catch {
        if (!ignore) {
          setSelectedLog(null);
          setDetailError("Unable to load the selected log record.");
        }
      } finally {
        if (!ignore) {
          setDetailLoading(false);
        }
      }
    }

    void loadLog();

    return () => {
      ignore = true;
    };
  }, [activeLogId, refreshToken]);

  const columns = useMemo<GridColDef<SystemLogRecord>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Timestamp",
        minWidth: 180,
        valueFormatter: (value) => formatDateTime(value as string | null),
      },
      {
        field: "vpsLabel",
        headerName: "VPS",
        minWidth: 230,
        flex: 1,
        renderCell: ({ row }) => (
          <Button
            size="small"
            sx={{ justifyContent: "flex-start", px: 0, minWidth: 0 }}
            onClick={(event) => {
              event.stopPropagation();
              applyListFilter({ vpsId: row.vpsId });
            }}
          >
            {row.vpsLabel}
          </Button>
        ),
      },
      {
        field: "scriptName",
        headerName: "Script",
        minWidth: 180,
        flex: 0.8,
        valueGetter: (_value, row) => row.scriptName || "-",
        renderCell: ({ row }) =>
          row.scriptName ? (
            <Button
              size="small"
              sx={{ justifyContent: "flex-start", px: 0, minWidth: 0 }}
              onClick={(event) => {
                event.stopPropagation();
                applyListFilter({ scriptName: row.scriptName });
              }}
            >
              {row.scriptName}
            </Button>
          ) : (
            <Typography color="text.secondary">-</Typography>
          ),
      },
      {
        field: "interactionType",
        headerName: "Log type",
        minWidth: 150,
      },
      {
        field: "logMessage",
        headerName: "Log message",
        minWidth: 280,
        flex: 1.5,
      },
      {
        field: "resultBadge",
        headerName: "Result",
        minWidth: 150,
        sortable: false,
        renderCell: ({ row }) => (
          <Chip label={resultBadgeLabel(row)} color={resultBadgeColor(row)} size="small" />
        ),
      },
    ],
    [applyListFilter]
  );

  const currentTitle = screen.kind === "details" ? "Log record" : "System Logs";
  const currentSubtitle =
    screen.kind === "details"
      ? "Inspect the selected log entry and any structured payloads."
      : "Review retained logs across all VPS records and scripts.";

  return (
    <Box sx={{ height: "100vh", overflow: "hidden", display: "flex", backgroundColor: "background.default" }}>
      <ControlCenterSidebar
        title="Operations"
        description="Global diagnostics, scripts, and remote endpoints."
        sections={controlCenterSections}
        activeHref="/logs"
        footerTitle="Log retention"
        footerBody={`${listData.totalCount} logs match the current filter.`}
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
            <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: 640 }}>
              {currentSubtitle}
            </Typography>
          </Box>

          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              startIcon={<RefreshRoundedIcon />}
              disabled={listLoading || detailLoading || isNavigating || clearingLogs}
              onClick={refreshScreen}
            >
              Refresh
            </Button>
            {screen.kind !== "list" ? (
              <Button
                variant="outlined"
                startIcon={<ArrowBackRoundedIcon />}
                onClick={() => navigateWithState({ logId: null }, "replace")}
              >
                Back
              </Button>
            ) : null}
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", px: { xs: 1.25, md: 2.5 }, pb: 2.5 }}>
          {screen.kind === "list" ? (
            <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0 }}>
              <Card>
                <CardContent>
                  <Stack
                    direction={{ xs: "column", lg: "row" }}
                    spacing={1.5}
                    useFlexGap
                    flexWrap="wrap"
                    alignItems={{ xs: "stretch", lg: "center" }}
                  >
                    <TextField
                      label="Log message"
                      value={searchInput}
                      onChange={(event) => {
                        setSearchInput(event.target.value);
                      }}
                      sx={{ minWidth: 260 }}
                      helperText={isSearchPending ? "Applying search..." : " "}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <SearchRoundedIcon fontSize="small" />
                          </InputAdornment>
                        ),
                        endAdornment: isSearchPending || searchInput ? (
                          <InputAdornment position="end">
                            <Stack direction="row" spacing={0.25} alignItems="center">
                              {isSearchPending ? <CircularProgress size={14} thickness={5} /> : null}
                              {searchInput ? (
                                <IconButton
                                  size="small"
                                  aria-label="Clear log message search"
                                  onClick={clearSearchFilter}
                                >
                                  <CloseRoundedIcon fontSize="small" />
                                </IconButton>
                              ) : null}
                            </Stack>
                          </InputAdornment>
                        ) : null,
                      }}
                    />
                    <TextField
                      label="Start"
                      type="datetime-local"
                      value={startAt}
                      onChange={(event) => {
                        const nextValue = event.target.value;

                        setStartAt(nextValue);
                        setPaginationModel((current) => ({ ...current, page: 0 }));
                        navigateWithState({ startAt: nextValue, page: 1 }, "replace");
                      }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <TextField
                      label="End"
                      type="datetime-local"
                      value={endAt}
                      onChange={(event) => {
                        const nextValue = event.target.value;

                        setEndAt(nextValue);
                        setPaginationModel((current) => ({ ...current, page: 0 }));
                        navigateWithState({ endAt: nextValue, page: 1 }, "replace");
                      }}
                      InputLabelProps={{ shrink: true }}
                    />
                    <FormControl sx={{ minWidth: 260 }}>
                      <InputLabel id="system-log-vps-filter-label">VPS</InputLabel>
                      <Select
                        labelId="system-log-vps-filter-label"
                        value={vpsFilter}
                        label="VPS"
                        onChange={(event) => {
                          const nextValue = String(event.target.value);

                          setVpsFilter(nextValue);
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                          navigateWithState({ vpsId: nextValue, page: 1 }, "replace");
                        }}
                      >
                        <MenuItem value="">All VPS records</MenuItem>
                        {listData.vpsOptions.map((option) => (
                          <MenuItem key={option.value} value={option.value}>
                            {option.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl sx={{ minWidth: 220 }}>
                      <InputLabel id="system-log-script-filter-label">Script</InputLabel>
                      <Select
                        labelId="system-log-script-filter-label"
                        value={scriptFilter}
                        label="Script"
                        onChange={(event) => {
                          const nextValue = String(event.target.value);

                          setScriptFilter(nextValue);
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                          navigateWithState({ scriptName: nextValue, page: 1 }, "replace");
                        }}
                      >
                        <MenuItem value="">All scripts</MenuItem>
                        {listData.scriptOptions.map((option) => (
                          <MenuItem key={option} value={option}>
                            {option}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 56, px: 0.5 }}>
                      <Typography color="text.secondary">All logs</Typography>
                      <Switch
                        checked={scriptResultsOnly}
                        onChange={(event) => {
                          const nextValue = event.target.checked;

                          setScriptResultsOnly(nextValue);
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                          navigateWithState({ scriptResultsOnly: nextValue, page: 1 }, "replace");
                        }}
                      />
                      <Typography color="text.secondary">Script results only</Typography>
                    </Stack>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 56 }}>
                      <Button variant="text" disabled={!hasActiveListState} onClick={clearListFilters}>
                        Clear filters
                      </Button>
                      <Button
                        color="error"
                        variant="outlined"
                        startIcon={<DeleteOutlineRoundedIcon />}
                        disabled={listLoading || clearingLogs || listData.totalCount === 0}
                        onClick={() => setClearLogsOpen(true)}
                      >
                        Clear logs
                      </Button>
                      <Button
                        variant="outlined"
                        startIcon={<DownloadRoundedIcon />}
                        disabled={exportingFormat !== null}
                        onClick={() => void exportLogs("json")}
                      >
                        Export JSON
                      </Button>
                      <Button
                        variant="outlined"
                        startIcon={<DownloadRoundedIcon />}
                        disabled={exportingFormat !== null}
                        onClick={() => void exportLogs("csv")}
                      >
                        Export CSV
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>

              <Card sx={{ flex: 1, minHeight: 0 }}>
                <CardContent sx={{ height: "100%", p: 1.25, display: "flex", flexDirection: "column", minHeight: 0 }}>
                  {listError ? <Alert severity="error">{listError}</Alert> : null}
                  <Stack
                    direction={{ xs: "column", md: "row" }}
                    spacing={1}
                    alignItems={{ xs: "flex-start", md: "center" }}
                    justifyContent="space-between"
                    sx={{ mb: 1.25 }}
                  >
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" alignItems="center">
                      <Typography variant="subtitle2" color="text.secondary">
                        Active filters
                      </Typography>
                      {activeFilterSummary.length ? (
                        activeFilterSummary.map((item) => (
                          <Chip
                            key={item.key}
                            label={item.label}
                            size="small"
                            variant="outlined"
                            onDelete={item.onDelete}
                          />
                        ))
                      ) : (
                        <Typography color="text.secondary">None</Typography>
                      )}
                    </Stack>
                    {hasActiveListState ? (
                      <Button size="small" onClick={clearListFilters}>
                        Reset view
                      </Button>
                    ) : null}
                  </Stack>
                  <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                    <DataGridPremium
                      density="compact"
                      rowHeight={40}
                      columnHeaderHeight={40}
                      rows={listData.items}
                      columns={columns}
                      getRowId={(row) => row.id}
                      loading={listLoading || isNavigating}
                      disableRowSelectionOnClick
                      pagination
                      paginationMode="server"
                      paginationModel={paginationModel}
                      onPaginationModelChange={(nextModel) => {
                        setPaginationModel(nextModel);
                        navigateWithState(
                          {
                            page: nextModel.page + 1,
                            pageSize: nextModel.pageSize,
                          },
                          "replace"
                        );
                      }}
                      pageSizeOptions={[10, 20, 50]}
                      rowCount={listData.totalCount}
                      onRowClick={(params: GridRowParams<SystemLogRecord>) =>
                        navigateWithState({ logId: params.row.id }, "push")
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
                            body="Adjust the period, VPS, script, or log mode filters."
                          />
                        ),
                      }}
                    />
                  </Box>
                </CardContent>
              </Card>
            </Stack>
          ) : (
            <Card>
              <CardContent>
                {detailError ? <Alert severity="error">{detailError}</Alert> : null}
                {!detailError && detailLoading ? (
                  <Typography color="text.secondary">Loading log record...</Typography>
                ) : selectedLog ? (
                  <Stack spacing={2}>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      <Chip label={resultBadgeLabel(selectedLog)} color={resultBadgeColor(selectedLog)} />
                      <Chip label={selectedLog.interactionType} variant="outlined" />
                      <Chip label={selectedLog.direction} variant="outlined" />
                    </Stack>
                    <Box
                      sx={{
                        display: "grid",
                        gap: 1.5,
                        gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
                      }}
                    >
                      <DetailField label="Timestamp" value={formatDateTime(selectedLog.createdAt)} />
                      <DetailField label="VPS" value={selectedLog.vpsLabel} />
                      <DetailField label="Script" value={selectedLog.scriptName || "-"} />
                      <DetailField label="Log type" value={selectedLog.interactionType} />
                      <DetailField label="Result" value={resultBadgeLabel(selectedLog)} />
                      <DetailField label="Message" value={selectedLog.logMessage} />
                      <DetailField label="Correlation ID" value={selectedLog.correlationId} />
                      <DetailField label="Request" value={`${selectedLog.requestMethod} ${selectedLog.requestPath}`} />
                      <DetailField label="HTTP status" value={selectedLog.responseStatusCode?.toString() ?? "-"} />
                      <DetailField label="Duration" value={selectedLog.durationMs === null ? "-" : `${selectedLog.durationMs} ms`} />
                      <DetailField label="Initiated by" value={selectedLog.initiatedBy} />
                      <DetailField label="Initiated by user" value={selectedLog.initiatedByUserId || "-"} />
                    </Box>
                    <StructuredDataBlock title="Request payload" value={selectedLog.requestPayload} />
                    <StructuredDataBlock title="Response payload" value={selectedLog.responsePayload} />
                    {selectedLog.taskLogText ? <StructuredDataBlock title="Task log" value={selectedLog.taskLogText} /> : null}
                  </Stack>
                ) : (
                  <EmptyState
                    title="Log record unavailable"
                    body="The selected log could not be loaded."
                  />
                )}
              </CardContent>
            </Card>
          )}
        </Box>
      </Box>

      <Dialog open={clearLogsOpen} onClose={() => (!clearingLogs ? setClearLogsOpen(false) : undefined)} maxWidth="sm" fullWidth>
        <DialogTitle>Clear log records</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1}>
            <Typography>
              {listData.totalCount === 1
                ? "Delete 1 log record that matches the current filter? This cannot be undone."
                : `Delete ${listData.totalCount} log records that match the current filter? This cannot be undone.`}
            </Typography>
            <Typography color="text.secondary">
              {activeFilterSummary.length
                ? `Current filter: ${activeFilterSummary.map((item) => item.label).join(" | ")}`
                : "Current filter: all retained logs."}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={clearingLogs} onClick={() => setClearLogsOpen(false)}>
            Cancel
          </Button>
          <Button color="error" variant="contained" disabled={clearingLogs} onClick={() => void clearFilteredLogs()}>
            {clearingLogs ? "Clearing..." : "Clear logs"}
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.25} sx={{ height: "100%", px: 2, textAlign: "center" }}>
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
        <HistoryRoundedIcon color="primary" />
      </Box>
      <Typography variant="h6">{title}</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 360 }}>
        {body}
      </Typography>
    </Stack>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ mt: 0.75, whiteSpace: "pre-wrap" }}>{value}</Typography>
    </Box>
  );
}

function StructuredDataBlock({ title, value }: { title: string; value: unknown }) {
  const isStructured = isStructuredValue(value);
  const serializedValue = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  const isCopyable = title === "Request payload" || title === "Response payload" || title === "Task log";
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 1500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(serializedValue);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [serializedValue]);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle2" color="text.secondary">
          {title}
        </Typography>
        {isCopyable ? (
          <IconButton
            size="small"
            onClick={handleCopy}
            aria-label={`Copy ${title.toLowerCase()} to clipboard`}
            title={copied ? "Copied" : `Copy ${title.toLowerCase()}`}
            sx={{ color: copied ? "success.main" : "text.secondary" }}
          >
            {copied ? <CheckRoundedIcon fontSize="inherit" /> : <ContentCopyRoundedIcon fontSize="inherit" />}
          </IconButton>
        ) : null}
      </Stack>
      <Paper
        variant="outlined"
        sx={{
          mt: 0.5,
          p: isStructured ? 0 : 1.25,
          borderRadius: "7px",
          backgroundColor: "rgba(28, 25, 23, 0.02)",
          overflow: "hidden",
          border: "1px solid rgba(28, 25, 23, 0.08)",
          "& .cm-editor": {
            height: "auto",
            minHeight: 180,
          },
          "& .cm-scroller": {
            overflow: "auto",
          },
          "& .cm-content, & .cm-line": {
            whiteSpace: "pre",
          },
        }}
      >
        {isStructured ? (
          <CodeMirror
            value={serializedValue}
            extensions={[json()]}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            editable={false}
            theme="light"
          />
        ) : (
          <Typography
            component="pre"
            sx={{ m: 0, overflowX: "auto", fontFamily: "var(--font-ibm-plex-mono), monospace" }}
          >
            {serializedValue}
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
