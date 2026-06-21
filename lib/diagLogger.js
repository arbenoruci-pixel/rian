export default function initDiagLogger() {
  return {
    flush: () => Promise.resolve(false),
    stop: () => false,
  };
}
