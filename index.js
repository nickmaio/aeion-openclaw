import { aeionPlugin } from "./src/channel.js";

const plugin = {
  id: "aeion-openclaw",
  name: "aeion platform bridge",
  description: "Bridge for aeion messenger",
  register(api) {
    console.log("[aeion] register() called");
    api.logger.info("[aeion] Registering channel plugin...");
    api.registerChannel({ plugin: aeionPlugin });
    api.logger.info("[aeion] ✓ Channel plugin registered");
  },
};

export default plugin;
