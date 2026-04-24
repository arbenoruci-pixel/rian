"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { trackRender } from '@/lib/sensor';

export default function GatiRedirect() {
  trackRender('TransportGatiRedirect');
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
