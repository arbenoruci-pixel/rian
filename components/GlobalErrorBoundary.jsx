"use client";

import React from "react";
import { pushGlobalError } from "@/lib/globalErrors";

// React Error Boundary to catch UI crashes that would otherwise white-screen.
// Logs into localStorage (tepiha_global_errors) and shows a small recovery UI.

export default class GlobalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, msg: "" };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, msg: error?.message ? String(error.message) : "UI_CRASH" };
  }

  componentDidCatch(error, info) {
    try {
      pushGlobalError("ui/react_error_boundary", error, {
        componentStack: info?.componentStack ? String(info.componentStack) : undefined,
      });
    } catch {}
  }

  reset = () => {
    this.setState({ hasError: false, msg: "" });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          padding: 14,
          margin: 12,
          borderRadius: 14,
          border: "2px solid rgba(239,68,68,0.35)",
          background: "rgba(0,0,0,0.35)",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
        }}
      >
        <div style={{ fontWeight: 900, letterSpacing: 2, fontSize: 14 }}>
          DIÇKA SHKOI KEQ
        </div>
        <div style={{ opacity: 0.8, marginTop: 6, fontSize: 12, wordBreak: "break-word" }}>
          {this.state.msg || "UI_CRASH"}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={this.reset}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              fontWeight: 900,
              letterSpacing: 1,
            }}
          >
            TRY AGAIN
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              fontWeight: 900,
              letterSpacing: 1,
            }}
          >
            RELOAD
          </button>
        </div>
      </div>
    );
  }
}
