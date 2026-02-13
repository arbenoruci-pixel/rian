"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TePaPlotsuaraRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/transport/board");
  }, [router]);
  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7", display: "grid", placeItems: "center", fontWeight: 900 }}>
      DUKE HAPUR…
    </div>
  );
}
