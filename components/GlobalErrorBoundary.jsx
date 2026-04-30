"use client";

import React from "react";
import { getLastChunkCapture, getLastLazyImportFailure } from '@/lib/lazyImportRuntime';
import { isChunkLoadLikeError, pushGlobalError } from "@/lib/globalErrors";
import { bootLog } from '@/lib/bootLog';
import { exportLocalErrorLogText, pushLocalErrorLog } from '@/lib/localErrorLog';

async function copyText(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}

// Final safety net only. Route/module boundaries should catch normal UI failures first.
export default class GlobalErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, msg: "", isChunkError: false, entry: null, copied: false };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      msg: error?.message ? String(error.message) : "UI_CRASH",
      isChunkError: isChunkLoadLikeError(error),
      copied: false,
    };
  }

  componentDidCatch(error, info) {
    const componentStack = info?.componentStack ? String(info.componentStack) : '';
    const isChunkError = isChunkLoadLikeError(error);
    const chunkMeta = {
      componentStack,
      lastLazyImportFailure: getLastLazyImportFailure(),
      lastChunkCapture: getLastChunkCapture(),
    };

    try {
      pushGlobalError("ui/global_safety_net", error, {
        componentStack,
        isChunkError,
        ...chunkMeta,
      });
    } catch {}

    try {
      const entry = pushLocalErrorLog(error, { componentStack }, {
        boundaryKind: 'global_safety_net',
        route: typeof window !== 'undefined' ? String(window.location?.pathname || '/') : '/',
        routePath: typeof window !== 'undefined' ? String(window.location?.pathname || '/') : '/',
        routeName: 'GLOBAL SAFETY NET',
        componentName: 'GlobalErrorBoundary',
        sourceLayer: 'global_error_boundary',
        isChunkError,
        ...chunkMeta,
      });
      this.setState({ entry });
    } catch {}

    try {
      bootLog('react_global_safety_net', {
        message: error?.message ? String(error.message) : 'UI_CRASH',
        componentStack,
        isChunkError,
      });
    } catch {}

    if (isChunkError) {
      try {
        window.dispatchEvent(new CustomEvent('tepiha:simple-incident', {
          detail: {
            incidentType: 'global_boundary_chunk_no_reload',
            lastEventType: 'global_boundary_chunk_no_reload',
            lastEventAt: new Date().toISOString(),
            currentPath: typeof window !== 'undefined' ? String(window.location?.pathname || '/') : '/',
            currentSearch: typeof window !== 'undefined' ? String(window.location?.search || '') : '',
            uiReady: false,
            overlayShown: true,
            meta: {
              source: 'global_error_boundary_safety_net_no_reload',
              message: error?.message ? String(error.message) : 'UI_CRASH',
              name: String(error?.name || ''),
              componentStack,
              lastLazyImportFailure: chunkMeta.lastLazyImportFailure,
              lastChunkCapture: chunkMeta.lastChunkCapture,
            },
          },
        }));
      } catch {}
    }
  }

  reset = () => {
    this.setState({ hasError: false, msg: "", isChunkError: false, entry: null, copied: false });
  };

  copyLog = async () => {
    const ok = await copyText(exportLocalErrorLogText(this.state.entry));
    this.setState({ copied: !!ok });
    try { window.setTimeout(() => this.setState({ copied: false }), 1400); } catch {}
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
          GLOBAL SAFETY NET
        </div>
        <div style={{ opacity: 0.8, marginTop: 6, fontSize: 12, wordBreak: "break-word" }}>
          {this.state.msg || "UI_CRASH"}
        </div>
        {this.state.isChunkError ? (
          <div style={{ opacity: 0.72, marginTop: 6, fontSize: 12 }}>
            U kap si lazy/module chunk failure. Kjo boundary nuk bën auto-reload; top-level boot rescue mbetet vetëm te index/app-root failure.
          </div>
        ) : null}
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
            PROVO PRAPË
          </button>
          <a
            href="/"
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(255,255,255,0.08)",
              color: "#fff",
              fontWeight: 900,
              letterSpacing: 1,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            KRYEFAQJA
          </a>
          <button
            onClick={this.copyLog}
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
            {this.state.copied ? 'U KOPJUA' : 'COPY ERROR'}
          </button>
        </div>
      </div>
    );
  }
}
