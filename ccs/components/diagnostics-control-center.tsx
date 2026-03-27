"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import HealthAndSafetyRoundedIcon from "@mui/icons-material/HealthAndSafetyRounded";
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
  Stack,
  Typography,
} from "@mui/material";

import { ControlCenterSidebar } from "@/components/control-center-sidebar";
import { controlCenterSections } from "@/lib/control-center-navigation";
import { OpenAiDiagnosticsResponse } from "@/lib/diagnostics-shared";

const operatorId = "operator@control-center";

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

function boolToChip(value: boolean | null) {
  if (value === true) {
    return { label: "Passed", color: "success" as const };
  }

  if (value === false) {
    return { label: "Failed", color: "error" as const };
  }

  return { label: "Unknown", color: "default" as const };
}

export function DiagnosticsControlCenter() {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [result, setResult] = useState<OpenAiDiagnosticsResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [isRunning, startRunning] = useTransition();

  const runDiagnostics = () => {
    startRunning(async () => {
      setRequestError(null);

      try {
        const payload = await requestJson<OpenAiDiagnosticsResponse>("/api/diagnostics/openai");
        setResult(payload);
      } catch (error) {
        const payload = error as OpenAiDiagnosticsResponse;

        setResult(payload ?? null);
        setRequestError(payload?.error?.message ?? "Diagnostics request failed.");
      }
    });
  };

  useEffect(() => {
    runDiagnostics();
  }, []);

  const checks = useMemo(
    () => [
      {
        key: "reachable",
        label: "OpenAI reachable",
        description: "Confirms the app can reach the OpenAI API and receive a response.",
        value: result?.checks.openAiReachable ?? null,
      },
      {
        key: "model",
        label: "Model specified",
        description: "Confirms a model name is present in the request.",
        value: result?.checks.modelSpecified ?? null,
      },
      {
        key: "api-key",
        label: "API key accepted",
        description: "Confirms OpenAI accepted the configured API key.",
        value: result?.checks.apiKeyAccepted ?? null,
      },
      {
        key: "funding",
        label: "Account funded",
        description: "Flags common billing and quota failures returned by OpenAI.",
        value: result?.checks.accountFunded ?? null,
      },
    ],
    [result]
  );

  return (
    <Box sx={{ height: "100dvh", display: "flex", overflow: "hidden", backgroundColor: "background.default" }}>
      <ControlCenterSidebar
        title="Diagnostics"
        description="Health checks for AI connectivity and configuration."
        sections={controlCenterSections}
        activeHref="/diagnostics"
        footerTitle="Current target"
        footerBody={result ? `Model ${result.model}${result.project ? ` on project ${result.project}` : ""}.` : "Preparing OpenAI diagnostics."}
      />

      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
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
            <Typography variant="h4">Diagnostics</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: 640 }}>
              Run an OpenAI connectivity check and inspect any returned API error details in an overlay.
            </Typography>
          </Box>

          <Button
            variant="contained"
            startIcon={<AutorenewRoundedIcon />}
            onClick={() => {
              setDialogOpen(true);
              runDiagnostics();
            }}
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "Run diagnostics"}
          </Button>
        </Box>

        <Box sx={{ px: { xs: 1.25, md: 2.5 }, pb: 2.5 }}>
          <Card elevation={0} sx={{ borderRadius: 3, border: "1px solid rgba(28, 25, 23, 0.08)" }}>
            <CardContent>
              <Stack spacing={2}>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "flex-start", md: "center" }}>
                  <Chip
                    icon={result?.ok ? <CheckCircleRoundedIcon /> : <ErrorOutlineRoundedIcon />}
                    label={result?.ok ? "Healthy" : result ? "Issue detected" : "Waiting for result"}
                    color={result?.ok ? "success" : result ? "error" : "default"}
                  />
                  <Typography color="text.secondary">
                    {result ? `Checking model ${result.model}.` : "Run the diagnostics command to inspect connectivity and billing."}
                  </Typography>
                </Stack>

                {requestError ? <Alert severity="error">{requestError}</Alert> : null}

                <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} useFlexGap flexWrap="wrap">
                  {checks.map((check) => {
                    const chip = boolToChip(check.value);

                    return (
                      <Card
                        key={check.key}
                        elevation={0}
                        sx={{
                          minWidth: 220,
                          flex: "1 1 220px",
                          borderRadius: 2.5,
                          border: "1px solid rgba(28, 25, 23, 0.08)",
                          backgroundColor: "rgba(255, 252, 247, 0.85)",
                        }}
                      >
                        <CardContent>
                          <Stack spacing={1}>
                            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                              <Typography variant="subtitle2">{check.label}</Typography>
                              <Chip size="small" label={chip.label} color={chip.color} />
                            </Stack>
                            <Typography color="text.secondary" sx={{ fontSize: "0.82rem" }}>
                              {check.description}
                            </Typography>
                          </Stack>
                        </CardContent>
                      </Card>
                    );
                  })}
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        </Box>
      </Box>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <HealthAndSafetyRoundedIcon color={result?.ok ? "success" : "action"} />
          OpenAI diagnostics
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {isRunning && !result ? <Alert severity="info">Running diagnostics against OpenAI.</Alert> : null}

            {result ? (
              <>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} useFlexGap flexWrap="wrap">
                  <Chip label={`Model: ${result.model}`} variant="outlined" />
                  <Chip label={result.project ? `Project: ${result.project}` : "Project: none"} variant="outlined" />
                  <Chip
                    label={result.ok ? "OpenAI check passed" : "OpenAI check failed"}
                    color={result.ok ? "success" : "error"}
                  />
                </Stack>

                <Divider />

                <Stack spacing={1.25}>
                  {checks.map((check) => {
                    const chip = boolToChip(check.value);

                    return (
                      <Stack key={check.key} direction="row" justifyContent="space-between" spacing={1.5} alignItems="center">
                        <Box>
                          <Typography variant="subtitle2">{check.label}</Typography>
                          <Typography color="text.secondary" sx={{ fontSize: "0.82rem" }}>
                            {check.description}
                          </Typography>
                        </Box>
                        <Chip size="small" label={chip.label} color={chip.color} />
                      </Stack>
                    );
                  })}
                </Stack>

                {result.response?.messagePreview ? (
                  <Alert severity="success">OpenAI response preview: {result.response.messagePreview}</Alert>
                ) : null}

                {result.error ? (
                  <Alert severity="error">
                    <strong>{result.error.message}</strong>
                    <br />
                    Status: {result.error.status ?? "n/a"}
                    <br />
                    Code: {result.error.code ?? "n/a"}
                    <br />
                    Type: {result.error.type ?? "n/a"}
                    <br />
                    Request ID: {result.error.requestId ?? "n/a"}
                  </Alert>
                ) : null}
              </>
            ) : (
              <Typography color="text.secondary">Waiting for diagnostics results.</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Close</Button>
          <Button
            variant="contained"
            startIcon={<AutorenewRoundedIcon />}
            onClick={runDiagnostics}
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "Run again"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}