import { aeionPlugin } from "./src/channel.js";
import { setAeionRuntime } from "./src/runtime.js";

const plugin = {
  id: "aeion-openclaw",
  name: "aeion platform bridge",
  description: "Bridge for aeion messenger",
  register(api) {
    console.log("[aeion] register() called");
    api.logger.info("[aeion] Registering channel plugin...");
    setAeionRuntime(api.runtime);
    api.registerChannel({ plugin: aeionPlugin });
    api.logger.info("[aeion] ✓ Channel plugin registered");
  },
};

export default plugin;
