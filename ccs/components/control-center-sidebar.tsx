"use client";

import Link from "next/link";

import { Box, List, ListItemButton, ListItemText, Typography } from "@mui/material";

import { ControlCenterSection } from "@/lib/control-center-navigation";

export function ControlCenterSidebar({
  title,
  description,
  sections,
  activeHref,
  footerTitle,
  footerBody,
}: {
  title: string;
  description: string;
  sections: ControlCenterSection[];
  activeHref: string;
  footerTitle: string;
  footerBody: string;
}) {
  return (
    <Box
      component="aside"
      sx={{
        width: 236,
        flexShrink: 0,
        height: "100dvh",
        overflowY: "auto",
        borderRight: "1px solid rgba(28, 25, 23, 0.08)",
        background:
          "linear-gradient(180deg, rgba(255, 250, 242, 0.96), rgba(247, 239, 223, 0.9))",
        p: 2,
        display: { xs: "none", md: "flex" },
        flexDirection: "column",
        gap: 2,
      }}
    >
      <Box sx={{ pb: 1.5, borderBottom: "1px solid rgba(28, 25, 23, 0.08)" }}>
        <Typography variant="overline" color="primary.main">
          Control Center
        </Typography>
        <Typography variant="h5" sx={{ mt: 0.25 }}>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5, fontSize: "0.82rem" }}>
          {description}
        </Typography>
      </Box>

      <List sx={{ p: 0 }}>
        {sections.map((section) => (
          <ListItemButton
            key={section.href}
            component={Link}
            href={section.href}
            selected={activeHref === section.href}
            sx={{
              mb: 0.25,
              px: 0,
              py: 0.35,
              borderRadius: 0,
              alignItems: "flex-start",
              bgcolor: "transparent",
              "&.Mui-selected": {
                bgcolor: "transparent",
              },
              "&.Mui-selected:hover": {
                bgcolor: "transparent",
              },
            }}
          >
            <ListItemText
              primary={section.label}
              secondary={section.description}
              slotProps={{
                primary: {
                  sx: {
                    fontWeight: activeHref === section.href ? 700 : 500,
                    color: activeHref === section.href ? "text.primary" : "text.secondary",
                    fontSize: "0.9rem",
                  },
                },
                secondary: {
                  sx: {
                    mt: 0.15,
                    fontSize: "0.73rem",
                    lineHeight: 1.4,
                  },
                },
              }}
            />
          </ListItemButton>
        ))}
      </List>

      <Box
        sx={{
          mt: "auto",
          pt: 1.5,
          borderTop: "1px solid rgba(28, 25, 23, 0.08)",
        }}
      >
        <Typography variant="subtitle2">{footerTitle}</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5, fontSize: "0.76rem" }}>
          {footerBody}
        </Typography>
      </Box>
    </Box>
  );
}
