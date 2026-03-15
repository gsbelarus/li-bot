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
    borderRadius: 6,
  },
  typography: {
    fontFamily: "var(--font-space-grotesk), sans-serif",
    body1: {
      fontSize: "0.94rem",
      lineHeight: 1.55,
    },
    body2: {
      fontSize: "0.88rem",
      lineHeight: 1.5,
    },
    h1: {
      fontWeight: 700,
      letterSpacing: "-0.04em",
      fontSize: "2.05rem",
      lineHeight: 1.08,
    },
    h2: {
      fontWeight: 700,
      letterSpacing: "-0.04em",
      fontSize: "1.7rem",
      lineHeight: 1.12,
    },
    h3: {
      fontWeight: 700,
      letterSpacing: "-0.03em",
      fontSize: "1.32rem",
      lineHeight: 1.16,
    },
    h4: {
      fontWeight: 700,
      letterSpacing: "-0.02em",
      fontSize: "1.08rem",
      lineHeight: 1.22,
    },
    h5: {
      fontWeight: 700,
      letterSpacing: "-0.015em",
      fontSize: "0.96rem",
      lineHeight: 1.28,
    },
    h6: {
      fontWeight: 700,
      letterSpacing: "-0.01em",
      fontSize: "0.88rem",
      lineHeight: 1.32,
    },
    subtitle1: {
      fontSize: "0.92rem",
      lineHeight: 1.45,
    },
    subtitle2: {
      fontSize: "0.8rem",
      lineHeight: 1.4,
    },
    button: {
      textTransform: "none",
      fontWeight: 600,
      fontSize: "0.84rem",
      letterSpacing: "-0.01em",
    },
    overline: {
      fontSize: "0.68rem",
      fontWeight: 700,
      letterSpacing: "0.08em",
    },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: "8px",
          border: "1px solid rgba(28, 25, 23, 0.07)",
          boxShadow: "0 10px 24px rgba(28, 25, 23, 0.04)",
        },
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          padding: 14,
          "&:last-child": {
            paddingBottom: 14,
          },
        },
      },
    },
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
          borderRadius: "7px",
          minHeight: "36px",
          height: "36px",
          paddingInline: 12,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: "5px",
          height: 22,
          fontSize: "0.72rem",
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          padding: 6,
        },
        sizeSmall: {
          padding: 4,
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: "7px",
        },
        input: {
          paddingTop: 9.5,
          paddingBottom: 9.5,
        },
      },
    },
    MuiInputBase: {
      styleOverrides: {
        root: {
          fontSize: "0.9rem",
        },
      },
    },
    MuiFormLabel: {
      styleOverrides: {
        root: {
          fontSize: "0.88rem",
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 32,
          paddingInline: 10,
          fontSize: "0.8rem",
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
