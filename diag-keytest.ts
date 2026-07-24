import { Database } from "bun:sqlite";

// Quick diagnostic: does ctx.modelRegistry.getApiKeyForProvider work, or hang?
// This simulates what bash-gate.ts does, but with a timeout on the key lookup itself.

async function testApiKeyResolution() {
  // Try loading the real registry like omp does
  const { discoverAuthStorage, ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
  const auth = await discoverAuthStorage();
  const reg = new ModelRegistry(auth);
  
  console.log("Refreshing registry...");
  const refreshStart = Date.now();
  await reg.refresh();
  console.log(`refresh took ${Date.now() - refreshStart}ms`);

  console.log("Calling getApiKeyForProvider('openrouter')...");
  const keyStart = Date.now();
  
  // Race against a 10s timeout
  const timeout = new Promise<null>((resolve) => setTimeout(() => {
    console.log(`TIMEOUT after ${Date.now() - keyStart}ms — getApiKeyForProvider hung`);
    resolve(null);
  }, 10000));
  
  const result = await Promise.race([
    reg.getApiKeyForProvider("openrouter"),
    timeout,
  ]);
  
  console.log(`getApiKeyForProvider returned in ${Date.now() - keyStart}ms`);
  console.log("result type:", typeof result);
  if (result && typeof result === "object") {
    console.log("keys:", Object.keys(result));
  }
  if (typeof result === "string") {
    console.log("string length:", result.length);
  }
}

await testApiKeyResolution();
