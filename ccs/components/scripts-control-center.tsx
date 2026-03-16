"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
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
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  DataGridPremium,
  GridColDef,
  GridPaginationModel,
  GridSortModel,
} from "@mui/x-data-grid-premium";
import { json } from "@codemirror/lang-json";
import ReactMarkdown from "react-markdown";

import { ControlCenterSidebar } from "@/components/control-center-sidebar";
import {
  ScriptConvertResponse,
  ScriptListResponse,
  ScriptMutationResponse,
  ScriptRecord,
  createEmptyScriptInstructions,
} from "@/lib/scripts-shared";

type ScreenState = { kind: "list" } | { kind: "create" } | { kind: "details"; scriptId: string };
type ScriptFormErrors = Partial<Record<"name" | "plainText" | "structuredInstructions" | "form", string>>;

interface ScriptFormValues {
  name: string;
  description: string;
  plainText: string;
  structuredInstructions: ScriptRecord["structuredInstructions"];
  isDisabled: boolean;
}

const operatorId = "operator@control-center";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toFormValues(record?: ScriptRecord | null): ScriptFormValues {
  return {
    name: record?.name ?? "",
    description: record?.description ?? "",
    plainText: record?.plainText ?? "",
    structuredInstructions:
      record?.structuredInstructions ?? createEmptyScriptInstructions(),
    isDisabled: record?.isDisabled ?? false,
  };
}

function toStructuredInstructionsText(value: ScriptFormValues["structuredInstructions"]) {
  return JSON.stringify(value, null, 2);
}

function parseStructuredInstructionsText(value: string) {
  const parsed = JSON.parse(value) as ScriptFormValues["structuredInstructions"];

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Structured instructions must be a JSON object.");
  }

  return parsed;
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
    <Stack alignItems="center" justifyContent="center" spacing={1.25} sx={{ height: "100%", px: 2, textAlign: "center" }}>
      <Typography variant="h6">{title}</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 460 }}>
        {body}
      </Typography>
      {action}
    </Stack>
  );
}

function ScriptDetailScreen({
  mode,
  record,
  onBack,
  onSaved,
  onDeleted,
}: {
  mode: "create" | "details";
  record?: ScriptRecord | null;
  onBack: () => void;
  onSaved: (item: ScriptRecord, message: string) => void;
  onDeleted: (item: ScriptRecord) => void;
}) {
  const [values, setValues] = useState<ScriptFormValues>(toFormValues(record));
  const [structuredInstructionsText, setStructuredInstructionsText] = useState(() =>
    toStructuredInstructionsText(toFormValues(record).structuredInstructions)
  );
  const [errors, setErrors] = useState<ScriptFormErrors>({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [markdownTab, setMarkdownTab] = useState<"source" | "preview">("source");
  const [isSaving, startSaving] = useTransition();
  const [isConverting, startConverting] = useTransition();

  const hasExistingRecord = mode === "details" && Boolean(record);

  const updateField = <K extends keyof ScriptFormValues>(key: K, value: ScriptFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  function validate() {
    const nextErrors: ScriptFormErrors = {};

    if (!values.name.trim()) {
      nextErrors.name = "Script name is required.";
    }

    if (!values.plainText.trim()) {
      nextErrors.plainText = "Script markdown is required.";
    }

    try {
      const parsedStructuredInstructions = parseStructuredInstructionsText(structuredInstructionsText);
      setValues((current) => ({
        ...current,
        structuredInstructions: parsedStructuredInstructions,
      }));
    } catch (error) {
      nextErrors.structuredInstructions =
        error instanceof Error ? error.message : "Structured instructions must be valid JSON.";
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function handleStructuredInstructionsChange(value: string) {
    setStructuredInstructionsText(value);

    try {
      const parsedStructuredInstructions = parseStructuredInstructionsText(value);
      setValues((current) => ({
        ...current,
        structuredInstructions: parsedStructuredInstructions,
      }));
      setErrors((current) => {
        if (!current.structuredInstructions) {
          return current;
        }

        return {
          ...current,
          structuredInstructions: undefined,
        };
      });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        structuredInstructions:
          error instanceof Error ? error.message : "Structured instructions must be valid JSON.",
      }));
    }
  }

  function handleSave() {
    if (!validate()) {
      return;
    }

    startSaving(async () => {
      try {
        const endpoint = hasExistingRecord ? `/api/scripts/${record?.id}` : "/api/scripts";
        const method = hasExistingRecord ? "PATCH" : "POST";
        const response = await requestJson<ScriptMutationResponse>(endpoint, {
          method,
          body: JSON.stringify(values),
        });
        onSaved(response.item, response.message);
      } catch (error) {
        if (typeof error === "object" && error && "errors" in error) {
          setErrors((error as { errors: ScriptFormErrors }).errors);
          return;
        }

        setErrors({ form: "Unable to save script." });
      }
    });
  }

  function handleConvert() {
    if (!values.plainText.trim()) {
      setErrors({ plainText: "Script markdown is required before conversion." });
      return;
    }

    startConverting(async () => {
      try {
        const response = await requestJson<ScriptConvertResponse>("/api/scripts/convert", {
          method: "POST",
          body: JSON.stringify({ plainText: values.plainText }),
        });
        setValues((current) => ({
          ...current,
          structuredInstructions: response.structuredInstructions,
        }));
        setStructuredInstructionsText(toStructuredInstructionsText(response.structuredInstructions));
        setErrors({});
      } catch {
        setErrors({ form: "Unable to convert markdown to structured instructions." });
      }
    });
  }

  async function handleDelete() {
    if (!record) {
      return;
    }

    try {
      await requestJson<{ message: string }>(`/api/scripts/${record.id}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      setDeleteOpen(false);
      onDeleted(record);
    } catch {
      setErrors({ form: "Unable to delete script." });
    }
  }

  return (
    <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0, overflow: "hidden" }}>
      <Card sx={{ flexShrink: 0 }}>
        <CardContent sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} justifyContent="space-between" alignItems={{ xs: "stretch", md: "flex-start" }}>
            <Box>
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                <Typography variant="h5">
                  {hasExistingRecord ? values.name || "Script details" : "Create Script"}
                </Typography>
                {record && record.timestampWarnings.length > 0 ? (
                  <Tooltip title={`Fallback timestamps: ${record.timestampWarnings.join(", ")}`}>
                    <Chip size="small" label="legacy timestamps" color="warning" variant="outlined" />
                  </Tooltip>
                ) : null}
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                Edit markdown, convert it to JSON, and manage status.
              </Typography>
            </Box>
            <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0, alignItems: "center" }}>
              <Button variant="outlined" startIcon={<ArrowBackRoundedIcon />} onClick={onBack}>
                Back
              </Button>
              <Button
                variant="outlined"
                startIcon={<AutoAwesomeRoundedIcon />}
                disabled={isConverting}
                onClick={handleConvert}
              >
                Convert to JSON
              </Button>
              <Button
                variant="contained"
                startIcon={<SaveRoundedIcon />}
                disabled={isSaving}
                onClick={handleSave}
              >
                {hasExistingRecord ? "Save" : "Create"}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {errors.form ? <Alert severity="error">{errors.form}</Alert> : null}

      <Box
        sx={{
          flex: 1,
          display: "grid",
          gap: 1.25,
          gridTemplateColumns: { xs: "1fr", xl: "0.9fr 1.1fr" },
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <Stack spacing={1.25} sx={{ minHeight: 0, overflow: "hidden" }}>
          <Card sx={{ flexShrink: 0 }}>
            <CardContent sx={{ p: 2 }}>
              <Stack spacing={1.25}>
                <TextField
                  label="Script name"
                  value={values.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  error={Boolean(errors.name)}
                  helperText={errors.name}
                  required
                />
                <TextField
                  label="Description"
                  value={values.description}
                  onChange={(event) => updateField("description", event.target.value)}
                  multiline
                  minRows={2}
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={!values.isDisabled}
                      onChange={(event) => updateField("isDisabled", !event.target.checked)}
                    />
                  }
                  label={values.isDisabled ? "Script disabled" : "Script enabled"}
                />
                {hasExistingRecord ? (
                  <Button
                    variant="text"
                    color="error"
                    startIcon={<DeleteOutlineRoundedIcon />}
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete script
                  </Button>
                ) : null}
              </Stack>
            </CardContent>
          </Card>

          <Card sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1.25, flex: 1, minHeight: 0, overflow: "hidden", p: 2 }}>
              <Typography variant="h6">Markdown</Typography>
              <Tabs
                value={markdownTab}
                onChange={(_event, value: "source" | "preview") => setMarkdownTab(value)}
                sx={{ minHeight: 32, flexShrink: 0 }}
              >
                <Tab label="Source" value="source" sx={{ minHeight: 32 }} />
                <Tab label="Preview" value="preview" sx={{ minHeight: 32 }} />
              </Tabs>
              {errors.plainText ? <Alert severity="error">{errors.plainText}</Alert> : null}
              <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                {markdownTab === "source" ? (
                  <Box
                    sx={{
                      flex: 1,
                      height: "100%",
                      minHeight: 0,
                      border: "1px solid rgba(28, 25, 23, 0.08)",
                      borderRadius: "7px",
                      overflow: "auto",
                      "& .cm-editor": {
                        height: "auto",
                        minHeight: "100%",
                      },
                      "& .cm-scroller": {
                        overflow: "auto",
                      },
                      "& .cm-content, & .cm-line": {
                        whiteSpace: "pre",
                      },
                    }}
                    tabIndex={0}
                  >
                    <CodeMirror
                      value={values.plainText}
                      onChange={(value) => updateField("plainText", value)}
                      extensions={[markdown()]}
                      basicSetup={{
                        lineNumbers: true,
                        foldGutter: false,
                      }}
                      theme="light"
                    />
                  </Box>
                ) : (
                  <Card
                    variant="outlined"
                    sx={{ height: "100%", overflowY: "auto", p: 1.25, borderRadius: "7px" }}
                  >
                    <Box
                      sx={{
                        color: "text.secondary",
                        "& p": { color: "text.secondary", my: 0.75 },
                        "& ol": {
                          my: 0.75,
                          pl: 3,
                          listStyleType: "decimal",
                          listStylePosition: "outside",
                        },
                        "& ul": {
                          my: 0.75,
                          pl: 3,
                          listStyleType: "disc",
                          listStylePosition: "outside",
                        },
                        "& li": {
                          color: "text.secondary",
                          display: "list-item",
                          mb: 0.35,
                        },
                        "& li > p": {
                          my: 0,
                        },
                      }}
                    >
                      <ReactMarkdown>{values.plainText || "Nothing to preview yet."}</ReactMarkdown>
                    </Box>
                  </Card>
                )}
              </Box>
            </CardContent>
          </Card>
        </Stack>

        <Card sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <CardContent sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 1.25, overflow: "hidden", p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
              <Box>
                <Typography variant="h6">Structured instructions</Typography>
                <Typography color="text.secondary" sx={{ mt: 0.35 }}>
                  Executable JSON for the bot.
                </Typography>
              </Box>
              <Chip label={`${values.structuredInstructions.steps.length} steps`} />
            </Stack>
            {errors.structuredInstructions ? (
              <Alert severity="error">{errors.structuredInstructions}</Alert>
            ) : null}
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                borderRadius: "7px",
                overflow: "auto",
                border: "1px solid rgba(28, 25, 23, 0.08)",
                "& .cm-editor": {
                  height: "auto",
                  minHeight: "100%",
                },
                "& .cm-scroller": {
                  overflow: "auto",
                },
                "& .cm-content, & .cm-line": {
                  whiteSpace: "pre",
                },
              }}
              tabIndex={0}
            >
              <CodeMirror
                value={structuredInstructionsText}
                onChange={handleStructuredInstructionsChange}
                extensions={[json()]}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                }}
                theme="light"
              />
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete script</DialogTitle>
        <DialogContent dividers>
          <Typography>
            Delete {record?.name ?? "this script"} from the library? The record will be soft deleted.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void handleDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export function ScriptsControlCenter() {
  const [screen, setScreen] = useState<ScreenState>({ kind: "list" });
  const [listData, setListData] = useState<ScriptListResponse>({
    items: [],
    totalCount: 0,
    page: 1,
    pageSize: 10,
  });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [disabledFilter, setDisabledFilter] = useState("");
  const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({ page: 0, pageSize: 10 });
  const [sortModel, setSortModel] = useState<GridSortModel>([{ field: "updatedAt", sort: "desc" }]);
  const [selectedScript, setSelectedScript] = useState<ScriptRecord | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isNavigating, startNavigation] = useTransition();

  const activeScriptId = screen.kind === "details" ? screen.scriptId : null;

  useEffect(() => {
    let ignore = false;

    async function loadScripts() {
      setListLoading(true);
      setListError(null);

      try {
        const sortEntry = sortModel[0];
        const params = new URLSearchParams({
          page: String(paginationModel.page + 1),
          pageSize: String(paginationModel.pageSize),
          search,
          disabled: disabledFilter,
          sortField: sortEntry?.field ?? "updatedAt",
          sortDirection: sortEntry?.sort ?? "desc",
        });
        const response = await requestJson<ScriptListResponse>(`/api/scripts?${params.toString()}`);

        if (!ignore) {
          setListData(response);
        }
      } catch {
        if (!ignore) {
          setListError("Unable to load scripts.");
        }
      } finally {
        if (!ignore) {
          setListLoading(false);
        }
      }
    }

    void loadScripts();

    return () => {
      ignore = true;
    };
  }, [disabledFilter, paginationModel.page, paginationModel.pageSize, refreshToken, search, sortModel]);

  useEffect(() => {
    if (!activeScriptId) {
      setSelectedScript(null);
      return;
    }

    let ignore = false;

    async function loadScript() {
      try {
        const response = await requestJson<{ item: ScriptRecord }>(`/api/scripts/${activeScriptId}`);

        if (!ignore) {
          setSelectedScript(response.item);
        }
      } catch {
        if (!ignore) {
          setSelectedScript(null);
        }
      }
    }

    void loadScript();

    return () => {
      ignore = true;
    };
  }, [activeScriptId, refreshToken]);

  function updatePagination(nextModel: GridPaginationModel) {
    queueMicrotask(() => {
      setPaginationModel((current) => {
        if (current.page === nextModel.page && current.pageSize === nextModel.pageSize) {
          return current;
        }

        return nextModel;
      });
    });
  }

  function updateSort(nextModel: GridSortModel) {
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

  const columns = useMemo<GridColDef<ScriptRecord>[]>(
    () => [
      { field: "name", headerName: "Name", flex: 1, minWidth: 200 },
      {
        field: "description",
        headerName: "Description",
        flex: 1.2,
        minWidth: 220,
        valueGetter: (_value, row) => row.description || "-",
      },
      {
        field: "isDisabled",
        headerName: "Status",
        minWidth: 200,
        renderCell: ({ row }) => (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
            <Chip
              size="small"
              label={row.isDisabled ? "disabled" : "enabled"}
              color={row.isDisabled ? "default" : "success"}
            />
            {row.timestampWarnings.length > 0 ? (
              <Tooltip title={`Fallback timestamps: ${row.timestampWarnings.join(", ")}`}>
                <Chip size="small" label="legacy timestamps" color="warning" variant="outlined" />
              </Tooltip>
            ) : null}
          </Stack>
        ),
      },
      {
        field: "updatedAt",
        headerName: "Updated",
        minWidth: 180,
        valueFormatter: (value) => formatDateTime(String(value)),
      },
      {
        field: "actions",
        headerName: "Actions",
        sortable: false,
        filterable: false,
        minWidth: 120,
        renderCell: ({ row }) => (
          <Tooltip title="Open details">
            <IconButton onClick={() => startNavigation(() => setScreen({ kind: "details", scriptId: row.id }))}>
              <VisibilityRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ),
      },
    ],
    [startNavigation]
  );

  return (
    <Box sx={{ height: "100dvh", display: "flex", overflow: "hidden", backgroundColor: "background.default" }}>
      <ControlCenterSidebar
        title="Automation Scripts"
        description="Manage reusable scripts and convert notes into JSON."
        sections={[
          { href: "/", label: "Remote VPS", description: "Registry and diagnostics" },
          { href: "/scripts", label: "Scripts", description: "Authoring and conversion" },
        ]}
        activeHref="/scripts"
        footerTitle="Script library"
        footerBody={`${listData.totalCount} scripts tracked. ${listData.items.filter((item) => !item.isDisabled).length} enabled on this page.`}
      />

      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
        <Box sx={{ px: { xs: 1.25, md: 2.5 }, py: 1.75, display: "flex", justifyContent: "space-between", alignItems: { xs: "flex-start", md: "center" }, gap: 1.25, flexWrap: "wrap", flexShrink: 0 }}>
          <Box>
            <Typography variant="h4">
              {screen.kind === "list" ? "Scripts" : screen.kind === "create" ? "Create Script" : "Script Details"}
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: 560 }}>
              {screen.kind === "list"
                ? "View and manage executable browser scripts."
                : "Edit metadata and markdown, then convert it with OpenAI."}
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.75}>
            {screen.kind === "list" ? (
              <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setScreen({ kind: "create" })}>
                Add script
              </Button>
            ) : null}
            <Button variant="outlined" onClick={() => setRefreshToken((value) => value + 1)}>
              Refresh
            </Button>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minHeight: 0, px: { xs: 1.25, md: 2.5 }, pb: 2.5, overflow: "hidden" }}>
          {screen.kind === "list" ? (
            <Stack spacing={1.25} sx={{ height: "100%", minHeight: 0, overflow: "hidden" }}>
              <Card>
                <CardContent>
                  <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5}>
                    <TextField
                      placeholder="Search by script name, description, or markdown"
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
                      <InputLabel id="disabled-filter-label">Status</InputLabel>
                      <Select
                        labelId="disabled-filter-label"
                        value={disabledFilter}
                        label="Status"
                        onChange={(event) => {
                          setDisabledFilter(String(event.target.value));
                          setPaginationModel((current) => ({ ...current, page: 0 }));
                        }}
                      >
                        <MenuItem value="">All scripts</MenuItem>
                        <MenuItem value="false">Enabled</MenuItem>
                        <MenuItem value="true">Disabled</MenuItem>
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
                      columns={columns}
                      getRowId={(row) => row.id}
                      loading={listLoading || isNavigating}
                      disableRowSelectionOnClick
                      pagination
                      paginationMode="server"
                      paginationModel={paginationModel}
                      onPaginationModelChange={updatePagination}
                      pageSizeOptions={[10, 25, 50]}
                      sortingMode="server"
                      sortModel={sortModel}
                      onSortModelChange={updateSort}
                      rowCount={listData.totalCount}
                      onRowDoubleClick={(params) => setScreen({ kind: "details", scriptId: params.row.id })}
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
                      }}
                      slots={{
                        noRowsOverlay: () => (
                          <EmptyState
                            title="No scripts yet"
                            body="Create the first script to populate the library."
                            action={
                              <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setScreen({ kind: "create" })}>
                                Add script
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

          {screen.kind === "create" ? (
            <ScriptDetailScreen
              key="create-script"
              mode="create"
              onBack={() => setScreen({ kind: "list" })}
              onSaved={(item, message) => {
                setSnackbar(message);
                setRefreshToken((value) => value + 1);
                setScreen({ kind: "details", scriptId: item.id });
              }}
              onDeleted={() => setScreen({ kind: "list" })}
            />
          ) : null}

          {screen.kind === "details" ? (
            selectedScript ? (
              <ScriptDetailScreen
                key={`script-${selectedScript.id}-${selectedScript.updatedAt}`}
                mode="details"
                record={selectedScript}
                onBack={() => setScreen({ kind: "list" })}
                onSaved={(item, message) => {
                  setSelectedScript(item);
                  setSnackbar(message);
                  setRefreshToken((value) => value + 1);
                }}
                onDeleted={(item) => {
                  setSnackbar(`Deleted ${item.name}.`);
                  setRefreshToken((value) => value + 1);
                  setScreen({ kind: "list" });
                }}
              />
            ) : (
              <EmptyState
                title="Script not available"
                body="The selected script could not be loaded."
                action={<Button variant="outlined" onClick={() => setScreen({ kind: "list" })}>Back to list</Button>}
              />
            )
          ) : null}
        </Box>
      </Box>

      <Snackbar open={Boolean(snackbar)} autoHideDuration={4000} onClose={() => setSnackbar(null)} message={snackbar} />
    </Box>
  );
}
