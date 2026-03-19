import { Suspense } from "react";

import { SystemLogsControlCenter } from "@/components/system-logs-control-center";

export default function LogsPage() {
  return (
    <Suspense fallback={null}>
      <SystemLogsControlCenter />
    </Suspense>
  );
}