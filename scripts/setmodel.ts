import { Database } from "bun:sqlite";
const db = new Database("pocket.db");
db.run(
  "INSERT OR REPLACE INTO overrides (user_id, key, value) VALUES (?, ?, ?)",
  [7575516389, "model", "chatbai/glm-5.3-flash"]
);
console.log(JSON.stringify(db.query("SELECT user_id, key, value FROM overrides").all()));
db.close();
