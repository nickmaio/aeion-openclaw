let runtime = null;

export function setAeionRuntime(nextRuntime) {
  runtime = nextRuntime;
}

export function getAeionRuntime() {
  if (!runtime) {
    throw new Error("[aeion] Runtime not initialized");
  }
  return runtime;
}
