import { OpencodeClient } from "../src/opencode/client";

const c = new OpencodeClient({ port: 4096 });
const models = await c.listModels();
console.log(JSON.stringify(models));
console.log(`TOTAL=${models.length}`);
