export interface ControlCenterSection {
  href: string;
  label: string;
  description: string;
}

export const controlCenterSections: ControlCenterSection[] = [
  { href: "/", label: "Remote VPS", description: "Registry and diagnostics" },
  { href: "/scripts", label: "Scripts", description: "Authoring and conversion" },
  { href: "/logs", label: "Logs", description: "System-wide retained logs" },
  { href: "/diagnostics", label: "Diagnostics", description: "OpenAI reachability and billing" },
];