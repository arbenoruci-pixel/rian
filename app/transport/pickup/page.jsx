"use client";

import { useEffect } from "react";
import { useRouter } from "@/lib/routerCompat.jsx";
import { trackRender } from '@/lib/sensor';

export default function PickupRedirect() {
  trackRender('TransportPickupRedirect');
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
