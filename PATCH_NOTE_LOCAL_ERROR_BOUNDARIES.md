# Local Error Boundaries Patch

Scope: UI/runtime safety only. No DB schema, Supabase table, API write flow, or business write payloads were changed.

## Added
- `components/LocalErrorBoundary.jsx`
  - Route/module/panel fallback UI.
  - Shows path, route/component, module, timestamp, error message.
  - Buttons: `PROVO PËRSËRI`, `KTHEHU NË HOME`, `COPY ERROR / COPY LOG`.

- `lib/localErrorLog.js`
  - Client-only localStorage ring buffer.
  - Keys:
    - `tepiha_local_error_log_v1`
    - `tepiha_local_error_last_v1`
  - Stores route, module, component, error stack/message, app epoch, build id, visibility, online status, last route event, and last sync/offline event.

## Changed
- `src/generated/routes.generated.jsx`
  - All generated route elements are wrapped in route-level `LocalErrorBoundary` after layout wrapping.
  - Covers `/pranimi`, `/pastrimi`, `/gati`, `/marrje-sot`, `/arka`, `/transport`, `/transport/board`, `/diag-raw`, `/diag-lite`, and other generated routes.

- `src/AppRoot.jsx`
  - Runtime widgets are wrapped with local module-level boundaries:
    - `ChunkLoadRuntime`
    - `RootResumeWatchdog`
    - `ServiceWorkerRegister`
    - `OfflineSyncRunner`
    - `SyncStarter`
    - `RuntimeIncidentUploader`
    - `SessionDock`

- `components/ChunkLoadRuntime.jsx`
  - Lazy/module/chunk failures are logged locally.
  - Controlled recovery requests are suppressed/logged under local strategy.
  - No route/module lazy error triggers app-wide reload from this runtime layer.

- `lib/globalErrors.js`
  - `tryChunkLoadSelfHeal()` now logs `chunk_self_heal_suppressed_local_strategy` and returns false.
  - Direct chunk-heal reload helper is also suppressed so route/module errors do not cause app-wide reload.
  - Existing top-level `index.html` boot rescue remains separate for true boot/index asset failure.

- `components/GlobalErrorBoundary.jsx` and `app/error.jsx`
  - Converted to final safety-net behavior.
  - No automatic chunk self-heal/reload from global React fallback.
  - Copy includes local error log.

- `app/gati/page.jsx`
  - Panel boundaries added around GATI SMS, audit, code menu, POS, edit measures, return-to-cleaning, and rack/location modal panels.

- `app/transport/board/page.jsx`
  - Board modules are isolated by module-level boundary.
  - SMS and rack/location panels are isolated by panel boundary.

- `app/arka/page.jsx`
  - ARKA key worker/pending side panels are isolated by panel boundary.

## Validation
- JSX/JS parse check passed for all modified files using Babel parser.
- `npm run build` could not complete in this container because the local Vite binary exits with `Bus error` even on `vite --version`; this appears environment/binary related rather than a syntax parse failure.
