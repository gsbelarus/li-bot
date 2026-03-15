"use client";

import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { LicenseInfo } from "@mui/x-license";

const muiLicenseKey = process.env.NEXT_PUBLIC_MUI_LICENSE;

if (muiLicenseKey) {
  LicenseInfo.setLicenseKey(muiLicenseKey);
}

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#0e6251",
    },
    secondary: {
      main: "#b85c38",
    },
    background: {
      default: "#ece5d7",
      paper: "#fffaf2",
    },
    success: {
      main: "#1f8a70",
    },
    warning: {
      main: "#d97706",
    },
    error: {
      main: "#b42318",
    },
    text: {
      primary: "#1c1917",
      secondary: "#57534e",
    },
  },
  shape: {
    borderRadius: 18,
  },
  typography: {
    fontFamily: "var(--font-space-grotesk), sans-serif",
    h1: {
      fontWeight: 700,
      letterSpacing: "-0.04em",
    },
    h2: {
      fontWeight: 700,
      letterSpacing: "-0.04em",
    },
    h3: {
      fontWeight: 700,
      letterSpacing: "-0.03em",
    },
    button: {
      textTransform: "none",
      fontWeight: 600,
    },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 18,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
        },
      },
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
