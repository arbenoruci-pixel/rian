"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Inbox is unified into /transport/board (email-style).
export default function TransportInboxRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/transport/board?tab=inbox");
  }, [router]);
  return (
    <div style={{ minHeight: "100vh", background: "#f2f2f7", display: "grid", placeItems: "center", fontWeight: 900 }}>
      DUKE HAPUR…
    </div>
  );
}
