// Runnable entry for development (`pnpm dev`) and tests; `bin/ensemble.js` imports main() from dist.
import { main } from "./index.js";

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
