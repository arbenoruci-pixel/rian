"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Single entry point for TRANSPORT: always go to the Apple-style board.
export default function TransportHome() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/transport/board");
  }, [router]);
  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7", display: "grid", placeItems: "center", color: "#111", fontWeight: 900 }}>
      DUKE HAPUR…
    </div>
  );
}
